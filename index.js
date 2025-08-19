/**
 * @file SBAPI Service
 *
 * @copyright 2025 Multnomah County
 * @license GNU Version 3
 *
 * This service acts as a middleware to translate requests into the SirsiDynix ILSWS API format.
 * It handles various reports related to patron information, holds, fees, and checkouts.
 */

'use strict'

// --- Imports ---
// Node.js core modules
const Stream = require('stream')

// Third-party libraries
const _ = require('lodash')
const Hapi = require('@hapi/hapi')
const Boom = require('@hapi/boom')
const axios = require('axios')
const axiosRetry = require('axios-retry')
const moment = require('moment')
const colors = require('ansi-colors')
const XMLWriter = require('xml-writer')
const ejs = require('ejs')
const yaml = require('node-yaml')

// --- Application Configuration ---
// Local modules
// SECURITY: It's highly recommended to use environment variables (e.g., via dotenv)
// for sensitive data like passwords and hostnames instead of a config.json file.
const config = require('./config.json')
const templates = yaml.readSync('./templates.yaml') // Load XML response templates

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'

// --- ASCII Art ---
const LOGO = String.raw`
  _____ ____    ____  ____  ____
 / ___/|    \  /    T|    \l    j
(   \_ |  o  )Y  o  ||  o  )|  T
 \__  T|    T|      ||   _/ |  |
 /  \ ||  O  ||  _  ||  |   |  |
 \    ||     ||  |  ||  |   j  l
  \___jl_____jl__j__jl__j  |____j
`

// --- Constants ---
// Patron custom information categories
const PCODE1_CATEGORY = `category${config.PCODE1_SOURCE_CATEGORY.padStart(2, '0')}`
const PCODE2_CATEGORY = `category${config.PCODE2_SOURCE_CATEGORY.padStart(2, '0')}`
const PCODE3_CATEGORY = `category${config.PCODE3_SOURCE_CATEGORY.padStart(2, '0')}`

// ILSWS API configuration
const ILSWS_BASE_URI = `https://${config.ILSWS_HOSTNAME}:${config.ILSWS_PORT}/${config.ILSWS_WEBAPP}`
const ILSWS_ORIGINATING_APP_ID = 'sbapi'

// Failure flags for renewal/overdue status
const FAILURE_FLAGS = {
  PATRON_BLOCKED: '12',
  EXCESSIVE_FINES: '11',
  ITEM_HAS_HOLDS: '13',
  MAX_RENEWALS_REACHED: '14',
  RENEWAL_ALLOWED: '10'
}

// Fine and renewal limits from config or defaults
const MAX_FINE_AMOUNT = config.MAX_FINE_AMOUNT || 50
const MAX_RENEWAL_COUNT = config.MAX_RENEWAL_COUNT || 50

// --- Hapi Server Initialization ---
const server = Hapi.server({
  host: config.SBAPI_HOST,
  port: config.SBAPI_PORT
})

// --- Axios HTTP Client Setup ---
/**
 * Axios instance configured for interacting with the ILSWS API.
 * Includes automatic retries and logging for all requests.
 */
const api = axios.create({
  baseURL: ILSWS_BASE_URI,
  timeout: config.ILWS_TIMEOUT || 20000,
  headers: {
    'sd-originating-app-id': ILSWS_ORIGINATING_APP_ID,
    'x-sirs-clientID': config.ILSWS_CLIENTID,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
})

// Axios response interceptor for logging backend requests
api.interceptors.response.use(response => {
  const responseTime = Date.now() - response.config['axios-retry'].lastRequestTime
  const statusCode = response.status === 200 ? colors.green('200') : colors.red(response.statusText)
  const backend = colors.red(config.SBAPI_BACKEND.toUpperCase() + ' =>')

  server.log(
    ['info', 'backend', 'ilsws'],
    `${backend} ${colors.cyan(response.config.method)} ${response.config.url} ${statusCode} (${responseTime}ms)`
  )
  return response
})

// Apply retry logic to the axios instance (3 retries with exponential backoff)
axiosRetry(api, { retries: 3, retryDelay: axiosRetry.exponentialDelay })

// --- ILSWS API Service ---
// Fields to include in patron data requests to optimize payload size
const ILSWS_PATRON_INCLUDE_FIELDS = [
  'profile', 'library', 'createdDate', 'estimatedOverdueAmount', 'barcode',
  'standing', 'customInformation', 'privilegeExpiresDate', 'holdRecordList', 'circRecordList',
  'patronStatusInfo{amountOwed, estimatedFines, availableHoldCount}',
  PCODE1_CATEGORY, PCODE2_CATEGORY, PCODE3_CATEGORY
].join()

/**
 * A collection of functions to interact with the ILSWS API endpoints.
 */
const ILSWS = {
  /**
   * Fetches metadata about the ILSWS API.
   * @returns {Promise<Object>} Axios response promise.
   */
  aboutIlsWs: () => api.get('aboutIlsWs'),

  /**
   * Logs in a staff user to get a session token.
   * @param {string} username - The staff username.
   * @param {string} password - The staff password.
   * @returns {Promise<Object>} Axios response promise containing the session token.
   */
  loginUser: (username, password) => api.post('user/staff/login', { login: username, password }),

  /**
   * Retrieves a patron's details using their barcode.
   * @param {string} token - The active session token.
   * @param {string} barcode - The patron's barcode.
   * @returns {Promise<Object>} Axios response promise with patron data.
   */
  getPatronByBarcode: (token, barcode) => api.get(`user/patron/barcode/${barcode}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: { includeFields: ILSWS_PATRON_INCLUDE_FIELDS }
  }),

  /**
   * Retrieves a patron's details using their user key.
   * @param {string} token - The active session token.
   * @param {string} key - The patron's user key.
   * @returns {Promise<Object>} Axios response promise with patron data.
   */
  getPatronByKey: (token, key) => api.get(`user/patron/key/${key}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: { includeFields: ILSWS_PATRON_INCLUDE_FIELDS }
  }),

  /**
   * Retrieves detailed information for a specific hold record.
   * @param {string} token - The active session token.
   * @param {string} key - The hold record key.
   * @returns {Promise<Object>} Axios response promise with hold data.
   */
  getHoldRecord: (token, key) => api.get(`circulation/holdRecord/key/${key}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: { includeFields: 'fillByDate,expirationDate,beingHeldDate,pickupLibrary,item{barcode},bib{title},status' }
  }),

  /**
   * Retrieves detailed information for a specific circulation record.
   * @param {string} token - The active session token.
   * @param {string} key - The circulation record key.
   * @returns {Promise<Object|null>} Axios response promise with circulation data, or null if not found.
   */
  getCircRecord: async (token, key) => {
    try {
      return await api.get(`circulation/circRecord/key/${key}`, {
        headers: { 'x-sirs-sessionToken': token },
        params: { includeFields: 'item{barcode,currentLocation},item{bib{title}},dueDate,overdue,estimatedOverdueAmount,item{holdRecordList{status}},renewalCount' }
      })
    } catch (error) {
      // Return null for 404 errors, re-throw other errors
      if (error.response && error.response.status === 404) {
        return null
      }
      throw error
    }
  },

  /**
   * Looks up an item's current circulation status.
   * @param {string} token - The active session token.
   * @param {string} itemKey - The item's key.
   * @returns {Promise<Object>} Axios response promise with item status.
   */
  lookupItemStatus: (token, itemKey) => api.get(`circulation/itemCircInfo/key/${itemKey}`, {
    headers: { 'x-sirs-sessionToken': token }
  }),

  /**
   * Cancels a hold record.
   * @param {string} token - The active session token.
   * @param {string} holdKey - The key of the hold to cancel.
   * @returns {Promise<Object>} Axios response promise.
   */
  cancelHold: (token, holdKey) => api.post('/circulation/holdRecord/cancelHold', {
    holdRecord: { resource: '/circulation/holdRecord', key: holdKey }
  }, {
    headers: { 'x-sirs-sessionToken': token }
  })
}

// --- Helper Functions ---

/**
 * Determines failure flags for an item based on patron and item status.
 * @param {object} patron - The patron data object from ILSWS.
 * @param {object} item - The item data object from ILSWS.
 * @returns {string[]} An array of failure flag codes.
 */
function setFailureFlags (patron, item) {
  const flags = []
  const blockedStatuses = ['BLOCKED', 'BARRED', 'EXCLUDED']

  // Patron status is blocked
  if (blockedStatuses.includes(patron.standing.key)) {
    flags.push(FAILURE_FLAGS.PATRON_BLOCKED)
  }

  // Fines exceed the configured limit
  if (parseFloat(patron.patronStatusInfo.fields.amountOwed.amount) > MAX_FINE_AMOUNT) {
    flags.push(FAILURE_FLAGS.EXCESSIVE_FINES)
  }

  // Item has active holds by other patrons
  if (item.holdCount > 0) {
    flags.push(FAILURE_FLAGS.ITEM_HAS_HOLDS)
  }

  // Item has reached its renewal limit
  if (parseInt(item.data.fields.renewalCount) >= MAX_RENEWAL_COUNT) {
    flags.push(FAILURE_FLAGS.MAX_RENEWALS_REACHED)
  }

  return flags
}

/**
 * Converts an ILSWS API date (YYYY-MM-DD) to SBAPI format (YYYYMMDD).
 * @param {string} date - The date string from the ILSWS API.
 * @returns {string} The formatted date string, or an empty string if input is invalid.
 */
const ILSWSDateToSBDate = (date) => date ? moment(date, 'YYYY-MM-DD').format('YYYYMMDD') : ''

// --- Report Handlers (SBAPI Logic) ---

/**
 * Collection of handlers for each SBAPI report type.
 */
const SBAPI = {
  /**
   * Handler for the 'userkey' report. Fetches patron key by barcode.
   */
  userkey: async (params, h) => {
    const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
    const token = loginResponse.data.sessionToken
    const patronResponse = await ILSWS.getPatronByBarcode(token, params.uid)
    const renderedXml = ejs.render(templates.userResponse, { data: patronResponse.data })
    return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  /**
   * Handler for the 'userbarcode' report. Fetches patron barcode by key.
   */
  userbarcode: async (params, h) => {
    const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
    const token = loginResponse.data.sessionToken
    const patronResponse = await ILSWS.getPatronByKey(token, params.ukey)
    const renderedXml = ejs.render(templates.userResponse, { data: patronResponse.data })
    return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  /**
   * Handler for the 'cancel' report. Cancels a patron's hold.
   */
  cancel: async (params, h) => {
    try {
      const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      const token = loginResponse.data.sessionToken
      await ILSWS.cancelHold(token, params.dbkey)
      const renderedXml = ejs.render(templates.cancelResponse, { result: 1 }) // Success
      return h.response(XML_HEADER + renderedXml).type('application/xml')
    } catch (error) {
      // This is a specifically checked-for error that requires a unique XML response format.
      if (error.response && error.response.status === 404) {
        const renderedXml = ejs.render(templates.cancelResponse, { result: 0 }) // Failure
        return h.response(XML_HEADER + renderedXml).type('application/xml')
      }
      // For all other errors, re-throw to be handled by the generic error handler.
      throw error
    }
  },

  /**
   * Handler for the 'hold' report. Fetches a patron's available and unavailable holds.
   */
  hold: async (params, h) => {
    const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
    const token = loginResponse.data.sessionToken
    const patronResponse = await ILSWS.getPatronByBarcode(token, params.uid)
    const patronData = patronResponse.data

    const holdRecordList = patronData.fields.holdRecordList
    let holdDetails = []
    if (holdRecordList) {
      const holdPromises = holdRecordList.map(hold => ILSWS.getHoldRecord(token, hold.key))
      holdDetails = (await Promise.all(holdPromises)).filter(Boolean) // Filter out any null responses
    }

    const renderedXml = ejs.render(templates.holdResponse, {
      data: patronData,
      // Holds ready for pickup
      holds: _.filter(holdDetails, o => _.get(o, 'data.fields.item') && _.get(o, 'data.fields.beingHeldDate')),
      // Holds not yet available
      holdsUA: _.filter(holdDetails, o => !_.get(o, 'data.fields.item') || !_.get(o, 'data.fields.beingHeldDate')),
      ILSWSDateToSBDate
    })
    return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  /**
   * Handler for the 'courtesy' report. Fetches items due soon for renewal notices.
   */
  courtesy: async (params, h) => {
    const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
    const token = loginResponse.data.sessionToken
    const patronResponse = await ILSWS.getPatronByBarcode(token, params.uid)
    const patronData = patronResponse.data

    const circRecordList = patronData.fields.circRecordList
    let circDetails = []
  	if (circRecordList) {
      const circPromises = circRecordList.map(circ => ILSWS.getCircRecord(token, circ.key))
      circDetails = (await Promise.all(circPromises)).filter(Boolean) // Filter out nulls
    }

    const renewItems = _.filter(circDetails, o => _.get(o, 'data.fields.item'))
  	renewItems.forEach(item => {
      const holdsOnItem = _.get(item, 'data.fields.item.fields.holdRecordList', [])
      item.holdCount = holdsOnItem.filter(hold => hold.fields.status === 'PLACED').length
      item.renewFlags = setFailureFlags(patronData.fields, item)
      if (item.renewFlags.length === 0) {
        item.renewFlags.push(FAILURE_FLAGS.RENEWAL_ALLOWED)
      }
    })

    const renderedXml = ejs.render(templates.courtesyResponse, {
      data: patronData,
      items: renewItems,
      ILSWSDateToSBDate
    })
  	return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  /**
   * Handler for the 'overdue' report. Fetches a patron's overdue items.
   */
  overdue: async (params, h) => {
  	const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
  	const token = loginResponse.data.sessionToken
  	const patronResponse = await ILSWS.getPatronByBarcode(token, params.uid)
  	const patronData = patronResponse.data

  	const circRecordList = patronData.fields.circRecordList
  	let circDetails = []
  	if (circRecordList) {
    	const circPromises = circRecordList.map(circ => ILSWS.getCircRecord(token, circ.key))
    	circDetails = (await Promise.all(circPromises)).filter(Boolean)
  	}

  	const overdueItems = _.filter(circDetails, e => _.get(e, 'data.fields.overdue'))
  	overdueItems.forEach(item => {
    	const holdsOnItem = _.get(item, 'data.fields.item.fields.holdRecordList', [])
    	item.holdCount = holdsOnItem.filter(hold => hold.fields.status === 'PLACED').length
    	item.overdueFlags = setFailureFlags(patronData.fields, item)
    	if (item.overdueFlags.length === 0) {
      	item.overdueFlags.push(FAILURE_FLAGS.RENEWAL_ALLOWED)
    	}
  	})

  	const renderedXml = ejs.render(templates.overdueResponse, {
    	data: patronData,
    	items: overdueItems,
    	ILSWSDateToSBDate
  	})
  	return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  /**
   * Handler for 'chkcharge' report. Finds a specific checked-out item for a patron.
   */
  chkcharge: async (params, h) => {
  	const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
  	const token = loginResponse.data.sessionToken
  	const patronResponse = await ILSWS.getPatronByBarcode(token, params.uid)
  	const patronData = patronResponse.data

  	const circRecordList = patronData.fields.circRecordList
  	let circDetails = []
  	if (circRecordList) {
    	const circPromises = circRecordList.map(circ => ILSWS.getCircRecord(token, circ.key))
    	circDetails = (await Promise.all(circPromises)).filter(Boolean)
  	}

  	const items = circDetails.filter(e => _.get(e, 'data.fields.item.fields.barcode') === params.id)
  	if (items.length === 0) {
    	const payload = { messageList: [{ code: 'SBAPI.Error.NotFound', message: 'Item not found for this patron (300)' }] }
    	return h.response(payload).type('application/json').code(404)
  	}

  	const renderedXml = ejs.render(templates.chkchargeResponse, {
    	data: patronData,
    	item: items[0]
  	})
  	return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  /**
   * Handler for 'chkhold' report. Checks the status of an item by its key.
   */
  chkhold: async (params, h) => {
  	const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
  	const token = loginResponse.data.sessionToken
  	const itemStatusResponse = await ILSWS.lookupItemStatus(token, params.ikey)
  	const itemStatusData = itemStatusResponse.data

  	// The central error handler is now responsible for catching API errors.
  	// This internal check is no longer needed. A success here is a true success.

  	const renderedXml = ejs.render(templates.chkholdResponse, { data: itemStatusData })
  	return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  /**
   * Handler for the 'fee' report. Fetches a patron's total amount owed.
   */
  fee: async (params, h) => {
  	const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
  	const token = loginResponse.data.sessionToken
  	const patronResponse = await ILSWS.getPatronByBarcode(token, params.uid)
  	const renderedXml = ejs.render(templates.feeResponse, { data: patronResponse.data })
  	return h.response(XML_HEADER + renderedXml).type('application/xml')
  }
}

// --- Main Request Handler ---
/**
 * Main request handler for all SBAPI reports. It validates the request
 * and delegates to the appropriate report handler.
 */
const reportRequestHandler = async (request, h) => {
  const reports = {
  	userkey: { params: ['uid'] },
  	userbarcode: { params: ['ukey'] },
  	hold: { params: ['uid'] },
  	courtesy: { params: ['uid'] },
  	overdue: { params: ['uid'] },
  	chkcharge: { params: ['uid', 'id'] },
  	chkhold: { params: ['ikey'] },
  	fee: { params: ['uid'] },
  	cancel: { params: ['dbkey'] },
  	holdexpiration: { params: ['data'] }
  }

  const reportName = request.query.report
  const reportConfig = reports[reportName]

  // Validate report type
  if (!reportConfig) {
  	const payload = { messageList: [{ code: 'SBAPI.Error.BadRequest', message: 'Invalid report type provided (100)' }] }
  	return h.response(payload).type('application/json').code(400)
  }

  // Validate required parameters are present
  const missingParams = reportConfig.params.filter(param => !request.query[param])
  if (missingParams.length > 0) {
  	const message = `Missing required parameters: ${missingParams.join(', ')} (101)`
  	const payload = { messageList: [{ code: 'SBAPI.Error.BadRequest', message }] }
  	return h.response(payload).type('application/json').code(400)
  }

  // SECURITY: Basic input sanitization could be added here to validate the format
  // of parameters like 'uid' or 'ikey' before passing them to the ILSWS API.

  try {
  	// Delegate to the specific report handler
  	return await SBAPI[reportName](request.query, h)
  } catch (error) {
  	return handleIlsWsError(error, h)
  }
}

/**
 * Centralized error handler for all ILSWS API interactions.
 * Passes the API's error response body through directly to the client.
 * @param {Error} error - The error object caught from an Axios request.
 * @param {object} h - The Hapi response toolkit.
 * @returns {object} A Hapi response object.
 */
function handleIlsWsError (error, h) {
  // Prioritize handling HTTP errors from the upstream API.
  if (error.response && error.response.data) {
  	const { status, data } = error.response
  	server.log(['error', 'ilsws'], `ILSWS API Error - Status: ${status}, Data: ${JSON.stringify(data)}`)

  	// Pass the entire error data object from the API directly to the client,
  	// preserving the original status code.
  	return h.response(data).type('application/json').code(status)
  }

  // Handle network/DNS errors where there is no `error.response`.
  if (error.code === 'ENOTFOUND') {
  	server.log(['error', 'ilsws'], `DNS resolution failed for ${config.ILSWS_HOSTNAME}`)
  	const payload = { messageList: [{ code: 'SBAPI.Error.ENOTFOUND', message: 'Cannot connect to the backend service.' }] }
  	return h.response(payload).type('application/json').code(502) // 502 Bad Gateway
  }
  if (error.code === 'ECONNABORTED') {
  	server.log(['error', 'ilsws'], `Request to ILSWS timed out: ${error.message}`)
  	const payload = { messageList: [{ code: 'SBAPI.Error.ECONNABORTED', message: 'Backend service timed out.' }] }
  	return h.response(payload).type('application/json').code(504) // 504 Gateway Timeout
  }

  // Generic fallback for any other unexpected internal errors.
  server.log(['error', 'unknown'], error)
  const payload = { messageList: [{ code: 'SBAPI.Error.Internal', message: 'An unexpected internal error occurred.' }] }
  return h.response(payload).type('application/json').code(500)
}


// --- Server Startup ---

/**
 * Initializes and starts the Hapi server.
 */
async function start () {
  try {
  	// Register logging plugin
  	await server.register({
    	plugin: require('@hapi/good'),
    	options: {
      	ops: false,
      	reporters: {
        	consoleReporter: [{
          	module: '@hapi/good-console',
          	args: [{ color: true }]
        	}, 'stdout']
      	}
    	}
  	})

  	// Define server routes
  	await server.route({
    	method: 'GET',
    	path: '/cgi-bin/sb.cgi',
    	handler: reportRequestHandler
  	})

  	await server.start()
  } catch (err) {
  	server.log(['error'], err)
  	process.exit(1)
  }

  // Log server information on startup
  server.log(['info'], colors.red(LOGO))
  server.log(['info'], `${colors.red('LISTENING:')} ${server.info.uri}`)

  // Check connectivity to the ILSWS API and log its version
  try {
  	const aboutResponse = await ILSWS.aboutIlsWs()
  	aboutResponse.data.fields.product.forEach(product => {
    	server.log(['info'], `${colors.red(product.name)}: ${product.version}`)
  	})
  } catch (error) {
  	server.log(['error'], 'Failed to connect to ILSWS API on startup.')
  	server.log(['error'], error.message)
  }
}

// Start the server
start()
