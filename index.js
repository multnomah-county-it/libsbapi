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
// Third-party libraries
const _ = require('lodash')
const Hapi = require('@hapi/hapi')
const axios = require('axios')
const axiosRetry = require('axios-retry')
const moment = require('moment')
const colors = require('ansi-colors')
const path = require('path')
const fs = require('fs')
const ejs = require('ejs')
const yaml = require('js-yaml')

// --- Application Configuration ---
// Local modules
// SECURITY: It's highly recommended to use environment variables for sensitive data.
const configPath = fs.existsSync(path.join(__dirname, 'config.json'))
  ? './config.json'
  : './config_sample.json'
const config = require(configPath)
const templates = yaml.load(fs.readFileSync(path.join(__dirname, 'templates.yaml'), 'utf8')) // Load XML response templates

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'

// --- ASCII Art ---
const LOGO = String.raw`
  _____ ____    ____  ____  ____
 / ___/|    \  /    T|    \l    j
(   \_ |  o  )Y  o  ||  o  )|  T
 \__  T|    T|      ||   _/ |  |
 /  \ ||  O  ||  _  ||  |   |  |
 \    ||     ||  |  ||  |   j  l
  \___jl_____jl__j__jl__j  |____j
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

// --- Session Management ---
let sessionToken = null

// --- Axios HTTP Client Setup ---
const api = axios.create({
  baseURL: ILSWS_BASE_URI,
  timeout: config.ILSWS_TIMEOUT || 20000, // Corrected typo: ILSWS_TIMEOUT
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
    `${backend} ${colors.cyan(response.config.method.toUpperCase())} ${response.config.url} ${statusCode} (${responseTime}ms)`
  )
  return response
})

// Apply retry logic to the axios instance
axiosRetry(api, { retries: 3, retryDelay: axiosRetry.exponentialDelay })

// --- ILSWS API Service ---
const ILSWS_PATRON_INCLUDE_FIELDS = [
  'profile', 'library', 'createdDate', 'estimatedOverdueAmount', 'barcode',
  'standing', 'customInformation', 'privilegeExpiresDate', 'holdRecordList', 'circRecordList',
  'patronStatusInfo{amountOwed, estimatedFines, availableHoldCount}',
  PCODE1_CATEGORY, PCODE2_CATEGORY, PCODE3_CATEGORY
].join()

const ILSWS = {
  aboutIlsWs: () => api.get('aboutIlsWs'),
  loginUser: (username, password) => api.post('user/staff/login', { login: username, password }),
  getPatronByBarcode: (token, barcode) => api.get(`user/patron/barcode/${barcode}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: { includeFields: ILSWS_PATRON_INCLUDE_FIELDS }
  }),
  getPatronByKey: (token, key) => api.get(`user/patron/key/${key}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: { includeFields: ILSWS_PATRON_INCLUDE_FIELDS }
  }),
  getHoldRecord: (token, key) => api.get(`circulation/holdRecord/key/${key}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: { includeFields: 'fillByDate,expirationDate,beingHeldDate,pickupLibrary,item{barcode},bib{title},status' }
  }),
  getCircRecord: async (token, key) => {
    try {
      return await api.get(`circulation/circRecord/key/${key}`, {
        headers: { 'x-sirs-sessionToken': token },
        params: { includeFields: 'item{barcode,currentLocation},item{bib{title}},dueDate,overdue,estimatedOverdueAmount,item{holdRecordList{status}},renewalCount' }
      })
    } catch (error) {
      if (error.response && error.response.status === 404) return null
      throw error
    }
  },
  lookupItemStatus: (token, itemKey) => api.get(`circulation/itemCircInfo/key/${itemKey}`, {
    headers: { 'x-sirs-sessionToken': token }
  }),
  cancelHold: (token, holdKey) => api.post('/circulation/holdRecord/cancelHold',
    { holdRecord: { resource: '/circulation/holdRecord', key: holdKey } },
    { headers: { 'x-sirs-sessionToken': token } }
  )
}

// --- Helper Functions ---

/**
 * Ensures a valid session token is available, creating one if needed.
 * @returns {Promise<string>} The active session token.
 */
async function getApiToken () {
  if (sessionToken) {
    return sessionToken
  }
  const loginResponse = await ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
  sessionToken = _.get(loginResponse, 'data.sessionToken')
  if (sessionToken) {
    server.log(['info', 'auth'], 'Successfully established new ILSWS session.')
  } else {
    server.log(['error', 'auth'], 'Failed to retrieve session token from login response.')
    throw new Error('Authentication failed.')
  }
  return sessionToken
}

/**
 * Fetches patron data by barcode and returns the token and data.
 * @param {string} barcode - The patron's barcode.
 * @returns {Promise<{token: string, patronData: object}>}
 */
async function getPatronData (barcode) {
  const token = await getApiToken()
  const patronResponse = await ILSWS.getPatronByBarcode(token, barcode)
  return { token, patronData: patronResponse.data }
}

/**
 * Fetches and returns full circulation records for a patron.
 * @param {string} token - The active session token.
 * @param {object} patronData - The patron data object from ILSWS.
 * @returns {Promise<object[]>} An array of circulation record details.
 */
async function getCirculationDetails (token, patronData) {
  const circRecordList = _.get(patronData, 'fields.circRecordList', [])
  if (circRecordList.length === 0) {
    return []
  }
  const circPromises = circRecordList.map(circ => ILSWS.getCircRecord(token, circ.key))
  // Filter out any null responses (e.g., from 404s)
  return (await Promise.all(circPromises)).filter(Boolean)
}

/**
 * Determines failure flags for an item based on patron and item status.
 * @param {object} patron - The patron data object from ILSWS.
 * @param {object} item - The item data object from ILSWS.
 * @returns {string[]} An array of failure flag codes.
 */
function setFailureFlags (patron, item) {
  const flags = []
  const blockedStatuses = ['BLOCKED', 'BARRED', 'EXCLUDED']

  // Use _.get for safe property access
  if (blockedStatuses.includes(_.get(patron, 'standing.key'))) {
    flags.push(FAILURE_FLAGS.PATRON_BLOCKED)
  }
  if (_.get(patron, 'patronStatusInfo.fields.amountOwed.amount', 0) > MAX_FINE_AMOUNT) {
    flags.push(FAILURE_FLAGS.EXCESSIVE_FINES)
  }
  if (item.holdCount > 0) {
    flags.push(FAILURE_FLAGS.ITEM_HAS_HOLDS)
  }
  if (_.get(item, 'data.fields.renewalCount', 0) >= MAX_RENEWAL_COUNT) {
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

const SBAPI = {
  userkey: async (params, h) => {
    const token = await getApiToken()
    const patronResponse = await ILSWS.getPatronByBarcode(token, params.uid)
    const renderedXml = ejs.render(templates.userResponse, { data: patronResponse.data })
    return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  userbarcode: async (params, h) => {
    const token = await getApiToken()
    const patronResponse = await ILSWS.getPatronByKey(token, params.ukey)
    const renderedXml = ejs.render(templates.userResponse, { data: patronResponse.data })
    return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  cancel: async (params, h) => {
    try {
      const token = await getApiToken()
      await ILSWS.cancelHold(token, params.dbkey)
      const renderedXml = ejs.render(templates.cancelResponse, { result: 1 }) // Success
      return h.response(XML_HEADER + renderedXml).type('application/xml')
    } catch (error) {
      if (_.get(error, 'response.status') === 404) {
        const renderedXml = ejs.render(templates.cancelResponse, { result: 0 }) // Failure
        return h.response(XML_HEADER + renderedXml).type('application/xml')
      }
      throw error // Re-throw for the central error handler
    }
  },

  hold: async (params, h) => {
    const { token, patronData } = await getPatronData(params.uid)
    const holdRecordList = _.get(patronData, 'fields.holdRecordList', [])
    let holdDetails = []

    if (holdRecordList.length > 0) {
      const holdPromises = holdRecordList.map(hold => ILSWS.getHoldRecord(token, hold.key))
      holdDetails = (await Promise.all(holdPromises)).filter(Boolean)
    }

    const renderedXml = ejs.render(templates.holdResponse, {
      data: patronData,
      holds: _.filter(holdDetails, o => _.get(o, 'data.fields.item') && _.get(o, 'data.fields.beingHeldDate')),
      holdsUA: _.filter(holdDetails, o => !_.get(o, 'data.fields.item') || !_.get(o, 'data.fields.beingHeldDate')),
      ILSWSDateToSBDate
    })
    return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  courtesy: async (params, h) => {
    const { token, patronData } = await getPatronData(params.uid)
    const circDetails = await getCirculationDetails(token, patronData)

    const renewItems = _.filter(circDetails, o => _.get(o, 'data.fields.item'))
    renewItems.forEach(item => {
      const holdsOnItem = _.get(item, 'data.fields.item.fields.holdRecordList', [])
      item.holdCount = holdsOnItem.filter(hold => _.get(hold, 'fields.status') === 'PLACED').length
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

  overdue: async (params, h) => {
    const { token, patronData } = await getPatronData(params.uid)
    const circDetails = await getCirculationDetails(token, patronData)

    const overdueItems = _.filter(circDetails, e => _.get(e, 'data.fields.overdue'))
    overdueItems.forEach(item => {
      const holdsOnItem = _.get(item, 'data.fields.item.fields.holdRecordList', [])
      item.holdCount = holdsOnItem.filter(hold => _.get(hold, 'fields.status') === 'PLACED').length
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

  chkcharge: async (params, h) => {
    const { token, patronData } = await getPatronData(params.uid)
    const circDetails = await getCirculationDetails(token, patronData)

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

  chkhold: async (params, h) => {
    const token = await getApiToken()
    const itemStatusResponse = await ILSWS.lookupItemStatus(token, params.ikey)
    const renderedXml = ejs.render(templates.chkholdResponse, { data: itemStatusResponse.data })
    return h.response(XML_HEADER + renderedXml).type('application/xml')
  },

  fee: async (params, h) => {
    const { patronData } = await getPatronData(params.uid)
    const renderedXml = ejs.render(templates.feeResponse, { data: patronData })
    return h.response(XML_HEADER + renderedXml).type('application/xml')
  }
}

// --- Main Request Handler ---
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
    cancel: { params: ['dbkey'] }
    // TODO: Implement handler for 'holdexpiration' report
    // holdexpiration: { params: ['data'] }
  }

  const reportName = request.query.report
  const reportConfig = reports[reportName]

  if (!reportName || !reportConfig) {
    const payload = { messageList: [{ code: 'SBAPI.Error.BadRequest', message: 'Invalid or missing report type (100)' }] }
    return h.response(payload).type('application/json').code(400)
  }

  const missingParams = reportConfig.params.filter(param => !request.query[param])
  if (missingParams.length > 0) {
    const message = `Missing required parameters for '${reportName}' report: ${missingParams.join(', ')} (101)`
    const payload = { messageList: [{ code: 'SBAPI.Error.BadRequest', message }] }
    return h.response(payload).type('application/json').code(400)
  }

  try {
    return await SBAPI[reportName](request.query, h)
  } catch (error) {
    return handleIlsWsError(error, h)
  }
}

/**
 * Centralized error handler for all ILSWS API interactions.
 */
function handleIlsWsError (error, h) {
  if (error.response && error.response.data) {
    const { status, data } = error.response
    // If token is invalid/expired, clear it to force re-login on the next request.
    if (status === 401 || status === 403) {
      sessionToken = null
      server.log(['warn', 'auth'], 'ILSWS session token expired or was invalid. Cleared for re-authentication.')
    }
    server.log(['error', 'ilsws'], `ILSWS API Error - Status: ${status}, Data: ${JSON.stringify(data)}`)
    return h.response(data).type('application/json').code(status)
  }

  if (error.code === 'ENOTFOUND') {
    server.log(['error', 'ilsws'], `DNS resolution failed for ${config.ILSWS_HOSTNAME}`)
    const payload = { messageList: [{ code: 'SBAPI.Error.ENOTFOUND', message: 'Cannot connect to the backend service.' }] }
    return h.response(payload).type('application/json').code(502) // Bad Gateway
  }
  if (error.code === 'ECONNABORTED') {
    server.log(['error', 'ilsws'], `Request to ILSWS timed out: ${error.message}`)
    const payload = { messageList: [{ code: 'SBAPI.Error.ECONNABORTED', message: 'Backend service timed out.' }] }
    return h.response(payload).type('application/json').code(504) // Gateway Timeout
  }

  server.log(['error', 'unknown'], error)
  const payload = { messageList: [{ code: 'SBAPI.Error.Internal', message: 'An unexpected internal error occurred.' }] }
  return h.response(payload).type('application/json').code(500)
}

// --- Server Startup ---
async function start () {
  try {
    await server.register({
      plugin: require('@hapi/good'),
      options: {
        ops: false,
        reporters: {
          consoleReporter: [{ module: '@hapi/good-console', args: [{ color: true }] }, 'stdout']
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/cgi-bin/sb.cgi',
      handler: reportRequestHandler
    })

    await server.start()
  } catch (err) {
    console.error(err)
    process.exit(1)
  }

  server.log(['info'], colors.red(LOGO))
  server.log(['info'], `${colors.red('LISTENING:')} ${server.info.uri}`)

  try {
    const aboutResponse = await ILSWS.aboutIlsWs()
    _.get(aboutResponse, 'data.fields.product', []).forEach(product => {
      server.log(['info'], `${colors.red(product.name)}: ${product.version}`)
    })
    // Pre-authorize on startup
    await getApiToken()
  } catch (error) {
    server.log(['error'], 'Failed to connect or log in to ILSWS API on startup.')
    server.log(['error'], error.message)
  }
}

if (require.main === module) {
  start()
}

module.exports = {
  server,
  api,
  ILSWS,
  SBAPI,
  FAILURE_FLAGS,
  MAX_FINE_AMOUNT,
  MAX_RENEWAL_COUNT,
  setFailureFlags,
  ILSWSDateToSBDate,
  reportRequestHandler,
  templates,
  start
}
