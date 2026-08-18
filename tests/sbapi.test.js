'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const ejs = require('ejs')
const {
  setFailureFlags,
  ILSWSDateToSBDate,
  reportRequestHandler,
  FAILURE_FLAGS,
  MAX_FINE_AMOUNT,
  MAX_RENEWAL_COUNT,
  templates
} = require('../index')

describe('Shoutbomb API (libsbapi) Tests', () => {
  const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'

  function createMockH () {
    return {
      response: (payload) => {
        const resp = {
          payload,
          statusCode: 200,
          headers: {},
          code: (code) => {
            resp.statusCode = code
            return resp
          },
          type: (contentType) => {
            resp.headers['content-type'] = contentType
            return resp
          }
        }
        return resp
      }
    }
  }

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

  describe('Failure Flags Calculation (setFailureFlags - Production Function)', () => {
    it('should identify blocked patron standing', () => {
      const patron = { standing: { key: 'BLOCKED' } }
      const item = { holdCount: 0 }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, [FAILURE_FLAGS.PATRON_BLOCKED])
    })

    it('should identify barred patron standing', () => {
      const patron = { standing: { key: 'BARRED' } }
      const item = { holdCount: 0 }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, [FAILURE_FLAGS.PATRON_BLOCKED])
    })

    it('should identify excessive fines (> MAX_FINE_AMOUNT)', () => {
      const patron = { patronStatusInfo: { fields: { amountOwed: { amount: MAX_FINE_AMOUNT + 5 } } } }
      const item = { holdCount: 0 }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, [FAILURE_FLAGS.EXCESSIVE_FINES])
    })

    it('should identify item with holds', () => {
      const patron = { standing: { key: 'OK' } }
      const item = { holdCount: 2 }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, [FAILURE_FLAGS.ITEM_HAS_HOLDS])
    })

    it('should identify max renewals reached', () => {
      const patron = { standing: { key: 'OK' } }
      const item = { holdCount: 0, data: { fields: { renewalCount: MAX_RENEWAL_COUNT } } }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, [FAILURE_FLAGS.MAX_RENEWALS_REACHED])
    })

    it('should return multiple flags when multiple conditions are met', () => {
      const patron = {
        standing: { key: 'BLOCKED' },
        patronStatusInfo: { fields: { amountOwed: { amount: MAX_FINE_AMOUNT + 25 } } }
      }
      const item = { holdCount: 1, data: { fields: { renewalCount: MAX_RENEWAL_COUNT } } }
      const flags = setFailureFlags(patron, item)
      assert.deepEqual(flags, [
        FAILURE_FLAGS.PATRON_BLOCKED,
        FAILURE_FLAGS.EXCESSIVE_FINES,
        FAILURE_FLAGS.ITEM_HAS_HOLDS,
        FAILURE_FLAGS.MAX_RENEWALS_REACHED
      ])
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
        renewFlags: [FAILURE_FLAGS.RENEWAL_ALLOWED],
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

  describe('Report Request Validation (reportRequestHandler - Production Handler)', () => {
    it('should return 400 if report parameter is missing', async () => {
      const req = { query: {} }
      const res = await reportRequestHandler(req, createMockH())
      assert.equal(res.statusCode, 400)
      assert.equal(res.payload.messageList[0].code, 'SBAPI.Error.BadRequest')
      assert.match(res.payload.messageList[0].message, /Invalid or missing report type \(100\)/)
    })

    it('should return 400 if report type is unknown', async () => {
      const req = { query: { report: 'nonexistent' } }
      const res = await reportRequestHandler(req, createMockH())
      assert.equal(res.statusCode, 400)
      assert.equal(res.payload.messageList[0].code, 'SBAPI.Error.BadRequest')
      assert.match(res.payload.messageList[0].message, /Invalid or missing report type \(100\)/)
    })

    it('should return 400 if required parameter is missing for report', async () => {
      const req = { query: { report: 'hold' } }
      const res = await reportRequestHandler(req, createMockH())
      assert.equal(res.statusCode, 400)
      assert.match(res.payload.messageList[0].message, /Missing required parameters for 'hold' report: uid \(101\)/)
    })

    it('should return 400 if one of multiple required parameters is missing for chkcharge', async () => {
      const req = { query: { report: 'chkcharge', uid: '12345' } }
      const res = await reportRequestHandler(req, createMockH())
      assert.equal(res.statusCode, 400)
      assert.match(res.payload.messageList[0].message, /Missing required parameters for 'chkcharge' report: id \(101\)/)
    })
  })
})
