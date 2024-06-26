'use strict'

const O_o = String.raw`
  _____ ____    ____  ____  ____ 
 / ___/|    \  /    T|    \l    j
(   \_ |  o  )Y  o  ||  o  )|  T 
 \__  T|     T|     ||   _/ |  | 
 /  \ ||  O  ||  _  ||  |   |  | 
 \    ||     ||  |  ||  |   j  l 
  \___jl_____jl__j__jl__j  |____j
`

const _ = require('lodash')
const Hapi = require('@hapi/hapi')
const Boom = require('@hapi/boom')
const axios = require('axios')
const axiosRetry = require('axios-retry')
const moment = require('moment')
const c = require('ansi-colors')
const Stream = require('stream')
const XMLWriter = require('xml-writer')
const ejs = require('ejs')
const yaml = require('node-yaml')

const config = require('./config.json')
const templates = yaml.readSync('./templates.yaml')

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'

const server = Hapi.server({
  host: config.SBAPI_HOST,
  port: config.SBAPI_PORT
})

const requestHandlers = {
  SBAPI: {
    report: async (r, h) => {
      const reports = {
        userkey: { params: ['uid'] },
        userbarcode: { params: ['ukey'] },
        hold: { params: ['uid'] },
        courtesy: { params: ['uid'] },
        overdue: { params: ['uid'] },
        chkcharge: { params: ['uid', 'id'] },
        chkhold: { params: ['id'] },
        fee: { params: ['uid'] },
        cancel: { params: ['dbkey'] },
        holdexpiration: { params: ['data'] }
      }

      if (!reports[r.query.report]) return Boom.badRequest('invalid report (100)')

      const missingParams = reports[r.query.report].params.filter(e => !r.query[e])
      if ( missingParams.length ) {
        return Boom.badRequest(`missing required parameters: ${missingParams.join()}` + ' (101)')
      }

      return SBAPI[r.query.report](r.query, h)
    }
  }
}

const PCODE1_CATEGORY = `category${config.PCODE1_SOURCE_CATEGORY.padStart(2, '0')}`
const PCODE2_CATEGORY = `category${config.PCODE2_SOURCE_CATEGORY.padStart(2, '0')}`
const PCODE3_CATEGORY = `category${config.PCODE3_SOURCE_CATEGORY.padStart(2, '0')}`
const ILSWS_BASE_URI = `https://${config.ILSWS_HOSTNAME}:${config.ILSWS_PORT}/${config.ILSWS_WEBAPP}`
const ILSWS_ORIGINATING_APP_ID = 'sbapi'

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

api.interceptors.response.use(response => {
  const responseTime = Date.now() - response.config['axios-retry'].lastRequestTime
  const statusCode = response.status === 200 ? c.green('200') : c.red(response.statusText)
  const backend = c.red(config.SBAPI_BACKEND.toUpperCase() + ' =>')

  server.log(
    ['info', 'backend', 'ilsws'],
    `${backend} ${c.cyan(response.config.method)} ${response.config.url} ${statusCode} (${responseTime}ms)`
  )
  return response
})

axiosRetry(api, { retries: 3, retryDelay: axiosRetry.exponentialDelay })

const ILSWS_PATRON_INCLUDE_FIELDS = [
  'profile',
  //  'birthDate',
  'library',
  //  'alternateID',
  'createdDate',
  //  'lastActivityDate',
  //  'claimsReturnedCount',
  'estimatedOverdueAmount',
  //  'lastName',
  //  'firstName',
  //  'middleName',
  //  'address1',
  'barcode',
  'standing',
  'customInformation',
  'patronStatusInfo{amountOwed, estimatedFines, availableHoldCount}',
  PCODE1_CATEGORY,
  PCODE2_CATEGORY,
  PCODE3_CATEGORY,
  'privilegeExpiresDate',
  'holdRecordList',
  'circRecordList'
]

const ILSWS = {
  aboutIlsWs: () => api.get('aboutIlsWs'),
  loginUser: (username, password) => api.post('rest/security/loginUser', {}, {
    params: { login: username, password: password }
  }),
  getPatronByBarcode: (token, barcode) => api.get(`user/patron/barcode/${barcode}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: {
      includeFields: ILSWS_PATRON_INCLUDE_FIELDS.join()
    }
  }),
  getPatronByKey: (token, key) => api.get(`user/patron/key/${key}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: {
      includeFields: ILSWS_PATRON_INCLUDE_FIELDS.join()
    }
  }),
  getPatronByAlternateID: (token, id) => api.get('user/patron/search', {
    headers: { 'x-sirs-sessionToken': token },
    params: {
      q: `${config.ILSWS_ALTERNATEID_FIELD || 'ALT_ID'}:${id}`,
      rw: 1,
      ct: 1,
      includeFields: ILSWS_PATRON_INCLUDE_FIELDS.join()
    }
  }),
  authenticatePatron: (barcode, pin) => api.post('user/patron/authenticate', {
    barcode: barcode,
    password: pin
  }),
  getPatronStatusInfo: (token, key) => api.get(`user/patronStatusInfo/key/${key}`, {
    headers: { 'x-sirs-sessionToken': token }
  }),
  getHoldRecord: (token, key) => api.get(`circulation/holdRecord/key/${key}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: {
      includeFields: 'fillByDate,expirationDate,beingHeldDate,pickupLibrary,item{barcode},bib{title},status'
    }
  }),
  getCircRecord: (token, key) => api.get(`circulation/circRecord/key/${key}`, {
    headers: { 'x-sirs-sessionToken': token },
    params: {
      includeFields: 'item{barcode,currentLocation},item{bib{title}},dueDate,overdue,estimatedOverdueAmount,item{holdRecordList{status}},renewalCount'
    }
  }).catch(error => {
    console.log(error.response.data)
    // console.log('FUUUU')
    if (error.response && error.response.status === 404) return null
    throw error
  }),
  lookupItemStatus: (token, barcode) => api.get(`rest/circulation/lookupItemStatus?itemID=${barcode}`, {
    headers: { 'x-sirs-sessionToken': token }
  }),
  cancelHold: (token, holdKey) => api.post('/circulation/holdRecord/cancelHold', {
    holdRecord: {
      resource: '/circulation/holdRecord',
      key: holdKey
    }
  }, {
    headers: { 'x-sirs-sessionToken': token }
  })
}

const setFailureFlags = (patron, item) => {
  const flags = []

  // patron status blocked
  // console.log(patron.standing.key)
  if (_.includes(['BLOCKED', 'BARRED', 'EXCLUDED'], patron.standing.key)) {
    flags.push('12')
  }

  // too many fines
  // TODO: put in config
  if (parseFloat(patron.patronStatusInfo.fields.amountOwed.amount) > 50) {
    flags.push('11')
  }

  if (item.holdCount > 0) flags.push('13')

  // TODO: renewal count in config
  if (parseInt(item.data.fields.renewalCount) >= 50) flags.push('14')

  return flags
}

const ILSWSDateToSBDate = (date) => date ? moment(date, 'YYYY-MM-DD').format('YYYYMMDD') : ''

const SBAPI = {

  userkey: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => ILSWS.getPatronByBarcode(loginData.sessionToken, params.uid))
      .then(getPatronBarcodeResponse => getPatronBarcodeResponse.data)
      .then(barcodeData => h.response(XML_HEADER + ejs.render(templates.userResponse, { data: barcodeData })).type('application/xml'))
      .catch(error => ILSWSErrorResponse(error))
  },

  cancel: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => ILSWS.cancelHold(loginData.sessionToken, params.dbkey))
      .then(getCancelHoldResponse => getCancelHoldResponse.data)
      .then(cancelData => h.response(XML_HEADER + ejs.render(templates.cancelResponse, { result: 1 })).type('application/xml'))
      .catch(error => {
        if (error.response.status === 404) {
          return h.response(XML_HEADER + ejs.render(templates.cancelResponse, { result: 0 })).type('application/xml')
        } else throw error
      })
      .catch(error => ILSWSErrorResponse(error))
  },

  userbarcode: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => ILSWS.getPatronByKey(loginData.sessionToken, params.ukey))
      .then(getPatronKeyResponse => getPatronKeyResponse.data)
      .then(keyData => h.response(XML_HEADER + ejs.render(templates.userResponse, { data: keyData })).type('application/xml'))
      .catch(error => ILSWSErrorResponse(error))
  },

  hold: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => Promise.all([loginData, ILSWS.getPatronByBarcode(loginData.sessionToken, params.uid)]))
      .then(([loginData, getPatronBarcodeResponse]) => Promise.all([loginData, getPatronBarcodeResponse.data]))
      .then(([loginData, barcodeData]) => {
        const holdRecordList = barcodeData.fields.holdRecordList
        if (!holdRecordList) return Promise.all([barcodeData, null])
        return Promise.all([barcodeData, axios.all(holdRecordList.map(holdRecord => ILSWS.getHoldRecord(loginData.sessionToken, holdRecord.key)))])
      })
      .then(([barcodeData, ...response]) => {
	if (response[0].length) response[0] = removeNulls(response[0])
        return h.response(XML_HEADER + ejs.render(templates.holdResponse, {
          data: barcodeData,
          holds: _.filter((response && response[0]) || [], o => _.get(o, 'data.fields.item') && _.get(o, 'data.fields.beingHeldDate')),
          holdsUA: _.filter((response && response[0]) || [], o => !_.get(o, 'data.fields.item') || !_.get(o, 'data.fields.beingHeldDate')),
          ILSWSDateToSBDate: ILSWSDateToSBDate
        })).type('application/xml')
      })
      .catch(error => ILSWSErrorResponse(error))
  },

  courtesy: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => Promise.all([loginData, ILSWS.getPatronByBarcode(loginData.sessionToken, params.uid)]))
      .then(([loginData, getPatronBarcodeResponse]) => Promise.all([loginData, getPatronBarcodeResponse.data]))
      .then(([loginData, barcodeData]) => {
        const circRecordList = barcodeData.fields.circRecordList
        if (!circRecordList) return Promise.all([barcodeData, null])
        return Promise.all([barcodeData, axios.all(circRecordList.map(circRecord => ILSWS.getCircRecord(loginData.sessionToken, circRecord.key)))])
      })
      .then(([barcodeData, ...response]) => {
	if (response[0].length) response[0] = removeNulls(response[0])
        const renewItems = _.filter((response && response[0]) || [], o => _.get(o, 'data.fields.item'))
        _.each(renewItems, i => {
          let count = 0
          _.each(i.data.fields.item.fields.holdRecordList, holdRecord => {
            if (holdRecord.fields.status === 'PLACED') count++
          })
          i.holdCount = count
          i.renewFlags = setFailureFlags(barcodeData.fields, i)
          if (i.renewFlags.length === 0) i.renewFlags.push('10')
        })

        return h.response(XML_HEADER + ejs.render(templates.courtesyResponse, {
          data: barcodeData,
          items: renewItems,
          ILSWSDateToSBDate: ILSWSDateToSBDate
        })).type('application/xml')
      })
      .catch(error => { console.log(error); return ILSWSErrorResponse(error) })
  },

  overdue: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => Promise.all([loginData, ILSWS.getPatronByBarcode(loginData.sessionToken, params.uid)]))
      .then(([loginData, getPatronBarcodeResponse]) => Promise.all([loginData, getPatronBarcodeResponse.data]))
      .then(([loginData, barcodeData]) => {
        const circRecordList = barcodeData.fields.circRecordList
        if (!circRecordList) return Promise.all([barcodeData, null])
        return Promise.all([barcodeData, axios.all(circRecordList.map(circRecord => ILSWS.getCircRecord(loginData.sessionToken, circRecord.key)))])
      })
      .then(([barcodeData, ...response]) => {
	if (response[0].length) response[0] = removeNulls(response[0])
	const overdueItems = _.filter((response && response[0]) || [], e => _.get(e, 'data.fields.overdue'))
        _.each(overdueItems, i => {
	  if (i.data.fields.item.fields.holdRecordList) {
            let count = 0
            _.each(i.data.fields.item.fields.holdRecordList, holdRecord => {
              if (holdRecord.fields.status === 'PLACED') count++
            })
            i.holdCount = count
            i.overdueFlags = setFailureFlags(barcodeData.fields, i)
            if (i.overdueFlags.length === 0) i.overdueFlags.push('10')
          }
        })
	// if (!overdueItems) return Boom.notFound('record not found (300)')
        return h.response(XML_HEADER + ejs.render(templates.overdueResponse, {
          data: barcodeData,
          items: overdueItems,
          ILSWSDateToSBDate: ILSWSDateToSBDate
        })).type('application/xml')
      })
      .catch(error => ILSWSErrorResponse(error))
  },

  chkcharge: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => Promise.all([loginData, ILSWS.getPatronByBarcode(loginData.sessionToken, params.uid)]))
      .then(([loginData, getPatronBarcodeResponse]) => Promise.all([loginData, getPatronBarcodeResponse.data]))
      .then(([loginData, barcodeData]) => {
        const circRecordList = barcodeData.fields.circRecordList
        if (!circRecordList) return Promise.all([barcodeData, null])
        return Promise.all([barcodeData, axios.all(circRecordList.map(circRecord => ILSWS.getCircRecord(loginData.sessionToken, circRecord.key)))])
      })
      .then(([barcodeData, ...response]) => {
	if (response[0].length) response[0] = removeNulls(response[0])
        const items = (response && response[0].filter(e => { return e.data.fields.item.fields.barcode === params.id }) || [])
        if (!items.length) return Boom.notFound('item not found for this patron (300)')
        return h.response(XML_HEADER + ejs.render(templates.chkchargeResponse, {
          data: barcodeData,
          item: items[0]
        })).type('application/xml')
      })
      .catch(error => ILSWSErrorResponse(error))
  },

  chkhold: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => ILSWS.lookupItemStatus(loginData.sessionToken, params.id))
      .then(lookupItemStatusResponse => lookupItemStatusResponse.data)
      .then((itemStatusData) => {
        if (itemStatusData.faultResponse && itemStatusData.faultResponse.string == 'Item not found in catalog') return Boom.notFound('record not found (301)')
        return h.response(XML_HEADER + ejs.render(templates.chkholdResponse, { data: itemStatusData })).type('application/xml')
      })
      .catch(error => ILSWSErrorResponse(error))
  },

  fee: (params, h) => {
    return ILSWS.loginUser(config.ILSWS_USERNAME, config.ILSWS_PASSWORD)
      .then(loginResponse => loginResponse.data)
      .then(loginData => ILSWS.getPatronByBarcode(loginData.sessionToken, params.uid))
      .then(getPatronBarcodeResponse => getPatronBarcodeResponse.data)
      .then(barcodeData => h.response(XML_HEADER + ejs.render(templates.feeResponse, { data: barcodeData })).type('application/xml'))
      .catch(error => ILSWSErrorResponse(error))
  }
}

function ILSWSErrorResponse (error) {
  if (error.response) {
    switch (error.response.status) {
      case 404:
        return Boom.notFound('record not found (300)')
        break
    }
  }

  switch (error.errno) {
    case 'ENOTFOUND':
      return Boom.badGateway(`DNS resolution failed for ${config.ILSWS_HOSTNAME}` + ' (400)')
    case 'ECONNABORTED':
      return Boom.gatewayTimeout(error.message + ' (500)')
    default:
      console.log(error)
      if ( typeof error.response.data !== 'undefined' ) {
        console.log(error.response.data.messageList[0].message)
      }
      return Boom.badImplementation(`ILSWS ${error.toString()}` + ' (600)')
  }
}

async function start () {
  try {
    await server.register([
      {
        plugin: require('@hapi/good'),
        options: {
          ops: false,
          reporters: {
            consoleReporter: [
              {
                module: '@hapi/good-console',
                args: [{ color: true }]
              },
              'stdout'
            ]
          }
        }
      }])

    await server.route([
      {
        method: 'GET',
        path: '/cgi-bin/sb.cgi',
        handler: requestHandlers.SBAPI.report
      }
    ])

    await server.start()
  } catch (err) {
    server.log(['error'], err)
    process.exit(1)
  }

  server.log(['info'], c.red(O_o))
  server.log(['info'], `${c.red('LISTENING:')} ${server.info.uri}`)
  ILSWS.aboutIlsWs()
    .then(aboutIlsWsResponse => aboutIlsWsResponse.data)
    .then(aboutIlsWsData => {
      aboutIlsWsData.fields.product.forEach(e => {
        server.log(['info'], `${c.red(e.name)}: ${e.version}`)
      })
    })
    .catch(error => server.log(['error'], error))
}

// Remove nulls from array
function removeNulls(myArray) {
  var len = myArray.length, i;
  for(i = 0; i < len; i++ ) myArray[i] && myArray.push(myArray[i])
  myArray.splice(0 , len)
  return myArray
}

start()
