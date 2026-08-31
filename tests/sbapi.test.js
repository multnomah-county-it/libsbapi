'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const ejs = require('ejs')
const {
  setFailureFlags,
  ILSWSDateToSBDate,
  getApiToken,
  getPatronData,
  getCirculationDetails,
  handleIlsWsError,
  reportRequestHandler,
  FAILURE_FLAGS,
  MAX_FINE_AMOUNT,
  MAX_RENEWAL_COUNT,
  ILSWS,
  templates
} = require('../index')

describe('Shoutbomb API (libsbapi) Tests', () => {
  const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n'

  // Backup original ILSWS methods before each test
  let originalIlsWs = {}

  beforeEach(() => {
    originalIlsWs = {
      loginUser: ILSWS.loginUser,
      getPatronByBarcode: ILSWS.getPatronByBarcode,
      getPatronByKey: ILSWS.getPatronByKey,
      getHoldRecord: ILSWS.getHoldRecord,
      getCircRecord: ILSWS.getCircRecord,
      lookupItemStatus: ILSWS.lookupItemStatus,
      cancelHold: ILSWS.cancelHold,
      aboutIlsWs: ILSWS.aboutIlsWs
    }
  })

  afterEach(() => {
    // Restore original methods
    Object.assign(ILSWS, originalIlsWs)
  })

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

  describe('Authentication and Session Management (getApiToken)', () => {
    it('should authenticate with ILSWS and return session token', async () => {
      // Force clearing cached token by passing 401 through handleIlsWsError
      handleIlsWsError({ response: { status: 401, data: {} } }, createMockH())

      let loginCalls = 0
      ILSWS.loginUser = async () => {
        loginCalls++
        return { data: { sessionToken: 'mock-session-token-123' } }
      }

      const token1 = await getApiToken()
      assert.equal(token1, 'mock-session-token-123')
      assert.equal(loginCalls, 1)

      // Next call should reuse cached token
      const token2 = await getApiToken()
      assert.equal(token2, 'mock-session-token-123')
      assert.equal(loginCalls, 1, 'Should reuse cached token without re-authenticating')
    })

    it('should throw Error if login fails to return a session token', async () => {
      handleIlsWsError({ response: { status: 401, data: {} } }, createMockH())

      ILSWS.loginUser = async () => {
        return { data: {} } // No sessionToken
      }

      await assert.rejects(
        async () => { await getApiToken() },
        { message: 'Authentication failed.' }
      )
    })
  })

  describe('Circulation Details Helper (getCirculationDetails & getPatronData)', () => {
    it('should return empty array if patron has no circ records', async () => {
      ILSWS.loginUser = async () => ({ data: { sessionToken: 'test-token' } })
      const circs = await getCirculationDetails('test-token', { fields: { circRecordList: [] } })
      assert.deepEqual(circs, [])
    })

    it('should fetch and filter circulation records', async () => {
      ILSWS.getCircRecord = async (token, key) => {
        if (key === '100') return { data: { key: '100', fields: { renewalCount: 0 } } }
        if (key === '200') return null // 404 filtered out
        return { data: { key, fields: { renewalCount: 1 } } }
      }

      const patronData = {
        fields: {
          circRecordList: [{ key: '100' }, { key: '200' }, { key: '300' }]
        }
      }

      const circs = await getCirculationDetails('test-token', patronData)
      assert.equal(circs.length, 2)
      assert.equal(circs[0].data.key, '100')
      assert.equal(circs[1].data.key, '300')
    })

    it('should fetch patron data by barcode via getPatronData', async () => {
      ILSWS.loginUser = async () => ({ data: { sessionToken: 'token-abc' } })
      ILSWS.getPatronByBarcode = async (token, barcode) => {
        assert.equal(token, 'token-abc')
        assert.equal(barcode, '21168000000000')
        return { data: { key: '999', fields: { barcode } } }
      }

      const result = await getPatronData('21168000000000')
      assert.equal(result.token, 'token-abc')
      assert.equal(result.patronData.key, '999')
    })
  })

  describe('Report Request Handlers (SBAPI Reports Integration)', () => {
    beforeEach(() => {
      ILSWS.loginUser = async () => ({ data: { sessionToken: 'test-token' } })
    })

    it('should handle userkey report (patron barcode lookup)', async () => {
      ILSWS.getPatronByBarcode = async (token, barcode) => ({
        data: {
          key: '1001',
          fields: {
            barcode,
            library: { key: 'NPO' }
          }
        }
      })

      const req = { query: { report: 'userkey', uid: '21168012345678' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-type'], 'application/xml')
      assert.match(res.payload, /<USER_KEY>1001<\/USER_KEY>/)
      assert.match(res.payload, /<USER_BARCODE>21168012345678<\/USER_BARCODE>/)
      assert.match(res.payload, /<USER_LIBRARY>NPO<\/USER_LIBRARY>/)
    })

    it('should handle userbarcode report (patron key lookup)', async () => {
      ILSWS.getPatronByKey = async (token, key) => ({
        data: {
          key,
          fields: {
            barcode: '21168087654321',
            library: { key: 'CEN' }
          }
        }
      })

      const req = { query: { report: 'userbarcode', ukey: '5544' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-type'], 'application/xml')
      assert.match(res.payload, /<USER_KEY>5544<\/USER_KEY>/)
      assert.match(res.payload, /<USER_BARCODE>21168087654321<\/USER_BARCODE>/)
      assert.match(res.payload, /<USER_LIBRARY>CEN<\/USER_LIBRARY>/)
    })

    it('should handle cancel report (successful cancellation)', async () => {
      let cancelledKey = null
      ILSWS.cancelHold = async (token, holdKey) => {
        cancelledKey = holdKey
        return { data: { success: true } }
      }

      const req = { query: { report: 'cancel', dbkey: '98765' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(cancelledKey, '98765')
      assert.equal(res.statusCode, 200)
      assert.match(res.payload, /<HOLD_CANCEL_STATUS>1<\/HOLD_CANCEL_STATUS>/)
    })

    it('should handle cancel report when hold is not found (404)', async () => {
      ILSWS.cancelHold = async () => {
        const error = new Error('Not found')
        error.response = { status: 404 }
        throw error
      }

      const req = { query: { report: 'cancel', dbkey: '99999' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.match(res.payload, /<HOLD_CANCEL_STATUS>0<\/HOLD_CANCEL_STATUS>/)
    })

    it('should handle hold report with available and unavailable holds', async () => {
      ILSWS.getPatronByBarcode = async () => ({
        data: {
          fields: {
            barcode: '21168000112233',
            holdRecordList: [{ key: 'H1' }, { key: 'H2' }]
          }
        }
      })

      ILSWS.getHoldRecord = async (token, key) => {
        if (key === 'H1') {
          return {
            data: {
              key: 'H1',
              fields: {
                fillByDate: '2026-09-01',
                expirationDate: '2026-09-07',
                beingHeldDate: '2026-08-30',
                pickupLibrary: { key: 'BEL' },
                item: { fields: { barcode: '31168000998877' } },
                bib: { fields: { title: 'Available Hold Book' } }
              }
            }
          }
        }
        return {
          data: {
            key: 'H2',
            fields: {
              bib: { fields: { title: 'Unavailable Hold Book' } }
            }
          }
        }
      }

      const req = { query: { report: 'hold', uid: '21168000112233' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.match(res.payload, /<HOLD_BARCODE>31168000998877<\/HOLD_BARCODE>/)
      assert.match(res.payload, /<HOLD_TITLE>Available Hold Book<\/HOLD_TITLE>/)
      assert.match(res.payload, /<HOLD_TITLE_UNAVAILABLE>Unavailable Hold Book<\/HOLD_TITLE_UNAVAILABLE>/)
    })

    it('should handle courtesy report with renewal flags calculation', async () => {
      ILSWS.getPatronByBarcode = async () => ({
        data: {
          fields: {
            barcode: '21168000112233',
            standing: { key: 'OK' },
            circRecordList: [{ key: 'C1' }, { key: 'C2' }]
          }
        }
      })

      ILSWS.getCircRecord = async (token, key) => {
        if (key === 'C1') {
          return {
            data: {
              fields: {
                dueDate: '2026-09-10',
                renewalCount: 0,
                item: {
                  fields: {
                    barcode: '31168000111111',
                    bib: { fields: { title: 'Clean Item' } },
                    holdRecordList: []
                  }
                }
              }
            }
          }
        }
        return {
          data: {
            fields: {
              dueDate: '2026-09-12',
              renewalCount: MAX_RENEWAL_COUNT,
              item: {
                fields: {
                  barcode: '31168000222222',
                  bib: { fields: { title: 'Max Renewals Item' } },
                  holdRecordList: [{ fields: { status: 'PLACED' } }]
                }
              }
            }
          }
        }
      }

      const req = { query: { report: 'courtesy', uid: '21168000112233' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.match(res.payload, /<COURTESY_BARCODE>31168000111111<\/COURTESY_BARCODE>/)
      assert.match(res.payload, /<COURTESY_TITLE>Clean Item<\/COURTESY_TITLE>/)
      assert.match(res.payload, /<COURTESY_RENEW_FLAG>10<\/COURTESY_RENEW_FLAG>/)
      assert.match(res.payload, /<COURTESY_BARCODE>31168000222222<\/COURTESY_BARCODE>/)
      assert.match(res.payload, /<COURTESY_RENEW_FLAG>13<\/COURTESY_RENEW_FLAG>/)
    })

    it('should handle overdue report filtering overdue items', async () => {
      ILSWS.getPatronByBarcode = async () => ({
        data: {
          fields: {
            barcode: '21168000112233',
            circRecordList: [{ key: 'C1' }, { key: 'C2' }]
          }
        }
      })

      ILSWS.getCircRecord = async (token, key) => {
        if (key === 'C1') {
          return {
            data: {
              fields: {
                overdue: true,
                dueDate: '2026-08-01',
                estimatedOverdueAmount: { amount: 5.00 },
                item: {
                  fields: {
                    barcode: '31168000333333',
                    bib: { fields: { title: 'Overdue Book' } }
                  }
                }
              }
            }
          }
        }
        return {
          data: {
            fields: {
              overdue: false, // Not overdue
              dueDate: '2026-09-20',
              item: { fields: { barcode: '31168000444444' } }
            }
          }
        }
      }

      const req = { query: { report: 'overdue', uid: '21168000112233' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.match(res.payload, /<OVERDUE_BARCODE>31168000333333<\/OVERDUE_BARCODE>/)
      assert.match(res.payload, /<OVERDUE_TITLE>Overdue Book<\/OVERDUE_TITLE>/)
      assert.doesNotMatch(res.payload, /31168000444444/)
    })

    it('should handle chkcharge report when item is charged out', async () => {
      ILSWS.getPatronByBarcode = async () => ({
        data: {
          fields: {
            barcode: '21168000112233',
            circRecordList: [{ key: 'C1' }]
          }
        }
      })

      ILSWS.getCircRecord = async () => ({
        data: {
          fields: {
            item: {
              fields: {
                barcode: '31168000555555',
                currentLocation: { key: 'CHECKEDOUT' }
              }
            }
          }
        }
      })

      const req = { query: { report: 'chkcharge', uid: '21168000112233', id: '31168000555555' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.match(res.payload, /<CHARGED>1<\/CHARGED>/)
    })

    it('should return 404 when chkcharge item is not found in patron circs', async () => {
      ILSWS.getPatronByBarcode = async () => ({
        data: {
          fields: {
            barcode: '21168000112233',
            circRecordList: []
          }
        }
      })

      const req = { query: { report: 'chkcharge', uid: '21168000112233', id: '31168000999999' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 404)
      assert.equal(res.payload.messageList[0].code, 'SBAPI.Error.NotFound')
    })

    it('should handle chkhold report for item hold status', async () => {
      ILSWS.lookupItemStatus = async (token, itemKey) => ({
        data: {
          key: itemKey,
          itemStatus: ['ONHOLD']
        }
      })

      const req = { query: { report: 'chkhold', ikey: '12345:1:1' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.match(res.payload, /<ITEM_KEY>12345:1:1<\/ITEM_KEY>/)
      assert.match(res.payload, /<ONHOLD>1<\/ONHOLD>/)
    })

    it('should handle fee report returning amount owed', async () => {
      ILSWS.getPatronByBarcode = async () => ({
        data: {
          fields: {
            barcode: '21168000112233',
            patronStatusInfo: {
              fields: {
                amountOwed: { amount: '18.75' }
              }
            }
          }
        }
      })

      const req = { query: { report: 'fee', uid: '21168000112233' } }
      const res = await reportRequestHandler(req, createMockH())

      assert.equal(res.statusCode, 200)
      assert.match(res.payload, /<FEE_TOTAL>18.75<\/FEE_TOTAL>/)
    })
  })

  describe('Centralized Error Handling (handleIlsWsError)', () => {
    it('should handle ILSWS API response errors and forward status/data', () => {
      const error = {
        response: {
          status: 404,
          data: { messageList: [{ code: 'ILSWS.NotFound', message: 'Patron not found' }] }
        }
      }
      const res = handleIlsWsError(error, createMockH())
      assert.equal(res.statusCode, 404)
      assert.equal(res.payload.messageList[0].code, 'ILSWS.NotFound')
    })

    it('should handle 401/403 errors and invalidate session token', () => {
      const error = {
        response: {
          status: 401,
          data: { messageList: [{ code: 'ILSWS.Unauthorized' }] }
        }
      }
      const res = handleIlsWsError(error, createMockH())
      assert.equal(res.statusCode, 401)
    })

    it('should map ENOTFOUND DNS failures to 502 Bad Gateway', () => {
      const error = new Error('getaddrinfo ENOTFOUND ilsws.example.com')
      error.code = 'ENOTFOUND'
      const res = handleIlsWsError(error, createMockH())
      assert.equal(res.statusCode, 502)
      assert.equal(res.payload.messageList[0].code, 'SBAPI.Error.ENOTFOUND')
      assert.match(res.payload.messageList[0].message, /Cannot connect to the backend service/)
    })

    it('should map ECONNABORTED timeouts to 504 Gateway Timeout', () => {
      const error = new Error('timeout of 20000ms exceeded')
      error.code = 'ECONNABORTED'
      const res = handleIlsWsError(error, createMockH())
      assert.equal(res.statusCode, 504)
      assert.equal(res.payload.messageList[0].code, 'SBAPI.Error.ECONNABORTED')
      assert.match(res.payload.messageList[0].message, /Backend service timed out/)
    })

    it('should map unhandled errors to 500 Internal Error', () => {
      const error = new Error('Something unexpected broke')
      const res = handleIlsWsError(error, createMockH())
      assert.equal(res.statusCode, 500)
      assert.equal(res.payload.messageList[0].code, 'SBAPI.Error.Internal')
      assert.match(res.payload.messageList[0].message, /An unexpected internal error occurred/)
    })
  })
})
