'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const ejs = require('ejs')
const moment = require('moment')
const _ = require('lodash')

describe('Shoutbomb API (libsbapi) Tests', () => {
  const templatesPath = path.join(__dirname, '..', 'templates.yaml')
  const templates = yaml.load(fs.readFileSync(templatesPath, 'utf8'))
  const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'

  const FAILURE_FLAGS = {
    PATRON_BLOCKED: '12',
    EXCESSIVE_FINES: '11',
    ITEM_HAS_HOLDS: '13',
    MAX_RENEWALS_REACHED: '14',
    RENEWAL_ALLOWED: '10'
  }

  const MAX_FINE_AMOUNT = 50
  const MAX_RENEWAL_COUNT = 50

  function setFailureFlags (patron, item) {
    const flags = []
    const blockedStatuses = ['BLOCKED', 'BARRED', 'EXCLUDED']

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

  const ILSWSDateToSBDate = (date) => date ? moment(date, 'YYYY-MM-DD').format('YYYYMMDD') : ''

  describe('Template Loading and Parsing', () => {
    it('should parse templates.yaml into a valid object with all expected template keys', () => {
      assert.ok(templates, 'templates object should exist')
      assert.ok(templates.userResponse, 'userResponse template missing')
      assert.ok(templates.cancelResponse, 'cancelResponse template missing')
      assert.ok(templates.holdResponse, 'holdResponse template missing')
      assert.ok(templates.courtesyResponse, 'courtesyResponse template missing')
      assert.ok(templates.overdueResponse, 'overdueResponse template missing')
      assert.ok(templates.chkchargeResponse, 'chkchargeResponse template missing')
      assert.ok(templates.chkholdResponse, 'chkholdResponse template missing')
      assert.ok(templates.feeResponse, 'feeResponse template missing')
    })
  })

  describe('Date Conversion Helper (ILSWSDateToSBDate)', () => {
    it('should format YYYY-MM-DD into YYYYMMDD', () => {
      assert.equal(ILSWSDateToSBDate('2026-08-18'), '20260818')
      assert.equal(ILSWSDateToSBDate('2025-12-31'), '20251231')
    })

    it('should return empty string for null, undefined, or empty date', () => {
      assert.equal(ILSWSDateToSBDate(''), '')
      assert.equal(ILSWSDateToSBDate(null), '')
      assert.equal(ILSWSDateToSBDate(undefined), '')
    })
  })

  describe('Failure Flags Calculation (setFailureFlags)', () => {
    it('should identify blocked patron standing', () => {
      const patron = { standing: { key: 'BLOCKED' } }
      const item = { holdCount: 0 }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, ['12'])
    })

    it('should identify barred patron standing', () => {
      const patron = { standing: { key: 'BARRED' } }
      const item = { holdCount: 0 }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, ['12'])
    })

    it('should identify excessive fines (> $50)', () => {
      const patron = { patronStatusInfo: { fields: { amountOwed: { amount: 55.00 } } } }
      const item = { holdCount: 0 }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, ['11'])
    })

    it('should identify item with holds', () => {
      const patron = { standing: { key: 'OK' } }
      const item = { holdCount: 2 }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, ['13'])
    })

    it('should identify max renewals reached', () => {
      const patron = { standing: { key: 'OK' } }
      const item = { holdCount: 0, data: { fields: { renewalCount: 50 } } }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, ['14'])
    })

    it('should return multiple flags when multiple conditions are met', () => {
      const patron = {
        standing: { key: 'BLOCKED' },
        patronStatusInfo: { fields: { amountOwed: { amount: 75.00 } } }
      }
      const item = { holdCount: 1, data: { fields: { renewalCount: 50 } } }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, ['12', '11', '13', '14'])
    })

    it('should return empty array for clean patron and item', () => {
      const patron = {
        standing: { key: 'OK' },
        patronStatusInfo: { fields: { amountOwed: { amount: 0 } } }
      }
      const item = { holdCount: 0, data: { fields: { renewalCount: 1 } } }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, [])
    })
  })

  describe('XML Template Rendering', () => {
    it('should render userResponse template correctly', () => {
      const mockData = {
        key: '445800',
        fields: {
          barcode: '21168045392313',
          library: { key: 'NPO' }
        }
      }
      const rendered = XML_HEADER + ejs.render(templates.userResponse, { data: mockData })
      assert.match(rendered, /<USER_BARCODE>21168045392313<\/USER_BARCODE>/)
      assert.match(rendered, /<USER_KEY>445800<\/USER_KEY>/)
      assert.match(rendered, /<USER_LIBRARY>NPO<\/USER_LIBRARY>/)
      assert.match(rendered, /<USER_BARCODE_EXPIRATION>99990101<\/USER_BARCODE_EXPIRATION>/)
    })

    it('should render cancelResponse template for success and failure', () => {
      const successXml = XML_HEADER + ejs.render(templates.cancelResponse, { result: 1 })
      assert.match(successXml, /<HOLD_CANCEL_STATUS>1<\/HOLD_CANCEL_STATUS>/)

      const failXml = XML_HEADER + ejs.render(templates.cancelResponse, { result: 0 })
      assert.match(failXml, /<HOLD_CANCEL_STATUS>0<\/HOLD_CANCEL_STATUS>/)
    })

    it('should render holdResponse with available and unavailable holds', () => {
      const mockPatron = { fields: { barcode: '21967002133994' } }
      const holdsAvailable = [{
        data: {
          key: '1234566',
          fields: {
            fillByDate: '2026-06-21',
            expirationDate: '2026-06-26',
            pickupLibrary: { key: 'JBBB' },
            item: { key: '1399486:1:2', fields: { barcode: '31967011537878' } },
            bib: { fields: { title: 'The Test Book' } }
          }
        }
      }]
      const holdsUnavailable = [{
        data: {
          key: '6492350',
          fields: {
            bib: { fields: { title: 'Pending Book' } }
          }
        }
      }]

      const rendered = XML_HEADER + ejs.render(templates.holdResponse, {
        data: mockPatron,
        holds: holdsAvailable,
        holdsUA: holdsUnavailable,
        ILSWSDateToSBDate
      })

      assert.match(rendered, /<USER_BARCODE>21967002133994<\/USER_BARCODE>/)
      assert.match(rendered, /<HOLD_BARCODE>31967011537878<\/HOLD_BARCODE>/)
      assert.match(rendered, /<HOLD_TITLE>The Test Book<\/HOLD_TITLE>/)
      assert.match(rendered, /<HOLD_AVAILABLE_DATE>20260621<\/HOLD_AVAILABLE_DATE>/)
      assert.match(rendered, /<HOLD_TITLE_UNAVAILABLE>Pending Book<\/HOLD_TITLE_UNAVAILABLE>/)
      assert.match(rendered, /<HOLD_DB_KEY>6492350<\/HOLD_DB_KEY>/)
    })

    it('should render courtesyResponse template', () => {
      const mockPatron = { fields: { barcode: '21967002133994' } }
      const items = [{
        holdCount: 0,
        renewFlags: ['10'],
        data: {
          fields: {
            dueDate: '2026-06-24',
            item: {
              key: '1399486:1:2',
              fields: {
                barcode: '31967010702333',
                bib: { fields: { title: 'Snacktime!' } }
              }
            }
          }
        }
      }]

      const rendered = XML_HEADER + ejs.render(templates.courtesyResponse, {
        data: mockPatron,
        items,
        ILSWSDateToSBDate
      })

      assert.match(rendered, /<COURTESY_BARCODE>31967010702333<\/COURTESY_BARCODE>/)
      assert.match(rendered, /<COURTESY_TITLE>Snacktime!<\/COURTESY_TITLE>/)
      assert.match(rendered, /<COURTESY_DUE_DATE>20260624<\/COURTESY_DUE_DATE>/)
      assert.match(rendered, /<COURTESY_RENEW_FLAG>10<\/COURTESY_RENEW_FLAG>/)
    })

    it('should render feeResponse template', () => {
      const mockPatron = {
        fields: {
          barcode: '21967002133994',
          patronStatusInfo: {
            fields: {
              amountOwed: { amount: '30.25' }
            }
          }
        }
      }

      const rendered = XML_HEADER + ejs.render(templates.feeResponse, { data: mockPatron })
      assert.match(rendered, /<USER_BARCODE>21967002133994<\/USER_BARCODE>/)
      assert.match(rendered, /<FEE_TOTAL>30.25<\/FEE_TOTAL>/)
    })

    it('should render chkchargeResponse template', () => {
      const mockPatron = { fields: { barcode: '21967002133994' } }
      const itemCheckedOut = {
        data: {
          fields: {
            item: {
              fields: {
                barcode: '31967011342030',
                currentLocation: { key: 'CHECKEDOUT' }
              }
            }
          }
        }
      }

      const rendered = XML_HEADER + ejs.render(templates.chkchargeResponse, {
        data: mockPatron,
        item: itemCheckedOut
      })

      assert.match(rendered, /<CHARGED>1<\/CHARGED>/)
    })

    it('should render chkholdResponse template', () => {
      const mockDataOnHold = { key: '1399486:1:2', itemStatus: ['ONHOLD'] }
      const rendered = XML_HEADER + ejs.render(templates.chkholdResponse, { data: mockDataOnHold })
      assert.match(rendered, /<ITEM_KEY>1399486:1:2<\/ITEM_KEY>/)
      assert.match(rendered, /<ONHOLD>1<\/ONHOLD>/)

      const mockDataNotOnHold = { key: '1399486:1:2', itemStatus: [] }
      const renderedNotOnHold = XML_HEADER + ejs.render(templates.chkholdResponse, { data: mockDataNotOnHold })
      assert.match(renderedNotOnHold, /<ONHOLD>0<\/ONHOLD>/)
    })
  })

  describe('Report Request Validation Logic', () => {
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
    }

    function validateRequest (query) {
      const reportName = query.report
      const reportConfig = reports[reportName]

      if (!reportName || !reportConfig) {
        return {
          statusCode: 400,
          payload: { messageList: [{ code: 'SBAPI.Error.BadRequest', message: 'Invalid or missing report type (100)' }] }
        }
      }

      const missingParams = reportConfig.params.filter(param => !query[param])
      if (missingParams.length > 0) {
        const message = `Missing required parameters for '${reportName}' report: ${missingParams.join(', ')} (101)`
        return {
          statusCode: 400,
          payload: { messageList: [{ code: 'SBAPI.Error.BadRequest', message }] }
        }
      }

      return { statusCode: 200 }
    }

    it('should return 400 if report parameter is missing', () => {
      const res = validateRequest({})
      assert.equal(res.statusCode, 400)
      assert.equal(res.payload.messageList[0].code, 'SBAPI.Error.BadRequest')
      assert.match(res.payload.messageList[0].message, /Invalid or missing report type \(100\)/)
    })

    it('should return 400 if report type is unknown', () => {
      const res = validateRequest({ report: 'nonexistent' })
      assert.equal(res.statusCode, 400)
      assert.equal(res.payload.messageList[0].code, 'SBAPI.Error.BadRequest')
      assert.match(res.payload.messageList[0].message, /Invalid or missing report type \(100\)/)
    })

    it('should return 400 if required parameter is missing for report', () => {
      const res = validateRequest({ report: 'hold' })
      assert.equal(res.statusCode, 400)
      assert.match(res.payload.messageList[0].message, /Missing required parameters for 'hold' report: uid \(101\)/)
    })

    it('should return 400 if one of multiple required parameters is missing for chkcharge', () => {
      const res = validateRequest({ report: 'chkcharge', uid: '12345' })
      assert.equal(res.statusCode, 400)
      assert.match(res.payload.messageList[0].message, /Missing required parameters for 'chkcharge' report: id \(101\)/)
    })

    it('should return 200 for valid report and required parameters', () => {
      const res = validateRequest({ report: 'userkey', uid: '21168045392313' })
      assert.equal(res.statusCode, 200)
    })
  })
})
