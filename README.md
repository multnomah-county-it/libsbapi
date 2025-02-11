# libsbapi

Originally written by Andrew Livesay

Maintained by John Houser (john.houser@multco.us) for Multnomah County Library

## Custom API for Integration of Shoutbomb with Symphony

NOTES: custom Information fails on test, LOSFORMAT policy does not exist

## SBAPI endpoints 

### _userkey_ – returns user key/user barcode/home library/barcode expiration date when querying a user barcode 

URL: https://server:port/cgi-bin/sb.cgi?report=userkey&uid=21168045392313

Input: 

uid 
: patron barcode number

Output:
```
    <USER>
        <USER_INFO>
            <USER_BARCODE>21168045392313</USER_BARCODE>
            <USER_KEY>445800</USER_KEY>
            <USER_LIBRARY>NPO</USER_LIBRARY>
            <USER_BARCODE_EXPIRATION>99990101</USER_BARCODE_EXPIRATION>
        </USER_INFO>
    </USER>
```

### _userbarcode_ – returns user key/user barcode/home library/barcode expiration date when querying a user key

URL: https://server:port/cgi-bin/sb.cgi?report=userbarcode&ukey=445800

Input:

ukey
: user internal key

Output:
```
    <USER>
        <USER_INFO>
            <USER_BARCODE>21168045392313</USER_BARCODE>
            <USER_KEY>445800</USER_KEY>
            <USER_LIBRARY>NPO</USER_LIBRARY>
            <USER_BARCODE_EXPIRATION>99990101</USER_BARCODE_EXPIRATION>
        </USER_INFO>
    </USER>
```

### _holds_ – returns barcode and item hold available for pickup and not yet filled, when querying a user barcode

URL: https://server:port/cgi-bin/sb.cgi?report=hold&uid=21967002133994

Input: 

uid
: patron barcode number

Output:
```
    <USER>
        <USER_BARCODE>21967002133994</USER_BARCODE>
        <HOLDS>
            <HOLD_ITEM>
                <HOLD_BARCODE>31967011537878</HOLD_BARCODE>
                <HOLD_ITEM_KEY>1399486:1:2</HOLD_ITEM_KEY>
                <HOLD_TITLE>The violets of March : a novel / Sarah Jio</HOLD_TITLE>
                <HOLD_AVAILABLE_DATE>20110621</HOLD_AVAILABLE_DATE>
                <HOLD_PICKUP_LOCATION>JBBB</HOLD_PICKUP_LOCATION>
                <HOLD_PICKUP_DATE>20110626</HOLD_PICKUP_DATE>
                < HOLD_DB_KEY>1234566</HOLD_DB_KEY >
            </HOLD_ITEM>
            <HOLD_ITEM>
                <HOLD_BARCODE>31967012061787</HOLD_BARCODE>
                <HOLD_ITEM_KEY>1399486:1:3</HOLD_ITEM_KEY>
                <HOLD_TITLE>The search / Nora Roberts</HOLD_TITLE>
                <HOLD_AVAILABLE_DATE>20110620</HOLD_AVAILABLE_DATE>
                <HOLD_PICKUP_LOCATION>JBBB</HOLD_PICKUP_LOCATION>
                <HOLD_PICKUP_DATE>20110625</HOLD_PICKUP_DATE>
                <HOLD_DB_KEY>1234567</HOLD_DB_KEY >
            </HOLD_ITEM>
        </HOLDS>
        <HOLDS_UNAVAILABLE>
            <HOLD_ITEM_UNAVAILABLE>
                <HOLD_TITLE_UNAVAILABLE>Battlestar Galactica. Season 3</HOLD_TITLE_UNAVAILABLE>
                <HOLD_DB_KEY>6492350</HOLD_DB_KEY>
            </HOLD_ITEM_UNAVAILABLE>
            <HOLD_ITEM_UNAVAILABLE>
                <HOLD_TITLE_UNAVAILABLE>Battlestar Galactica. Season 2.5</HOLD_TITLE_UNAVAILABLE>
                <HOLD_DB_KEY>6492352</HOLD_DB_KEY>
            </HOLD_ITEM_UNAVAILABLE>
        </HOLDS_UNAVAILABLE>
    </USER>
```

`</HOLD_DB_KEY>` is needed to enable the cancellation of this item hold.

### _courtesy_ – returns barcode and item barcode/title/due date/renew eligibility when querying a user barcode

https://server:port/cgi-bin/sb.cgi?report=courtesy&uid=21967002133994

Input:

uid
: patron barcode number

Output:
```
    <USER>
        <USER_BARCODE>21967002133994</USER_BARCODE>
        <COURTESY>
            <COURTESY_ITEM>
                <COURTESY_BARCODE>31967010702333</COURTESY_BARCODE>
                <COURTESY_ITEM_KEY>1399486:1:2</COURTESY_ITEM_KEY>
                <COURTESY_TITLE>Snacktime! / Barenaked Ladies</COURTESY_TITLE>
                <COURTESY_DUE_DATE>20110624</COURTESY_DUE_DATE>
                <COURTESY_RENEW_FLAG/>
            </COURTESY_ITEM>
            <COURTESY_ITEM>
                <COURTESY_BARCODE>31967011418475</COURTESY_BARCODE>
                <COURTESY_ITEM_KEY>1399486:1:2</COURTESY_ITEM_KEY>
                <COURTESY_TITLE>But not the hippopotamus / by Sandra Boynton</COURTESY_TITLE>
                <COURTESY_DUE_DATE>20110624</COURTESY_DUE_DATE>
                <COURTESY_RENEW_FLAG/>
            </COURTESY_ITEM>
            <COURTESY_ITEM>
                <COURTESY_BARCODE>31967011418236</COURTESY_BARCODE>
                <COURTESY_ITEM_KEY>1399486:1:2</COURTESY_ITEM_KEY>
                <COURTESY_TITLE>The going to bed book / by Sandra Boynton</COURTESY_TITLE>
                <COURTESY_DUE_DATE>20110624</COURTESY_DUE_DATE>
                <COURTESY_RENEW_FLAG/>
            </COURTESY_ITEM>
            <COURTESY_ITEM>
                <COURTESY_BARCODE>31967011418350</COURTESY_BARCODE>
                <COURTESY_ITEM_KEY>1399486:1:2</COURTESY_ITEM_KEY>
                <COURTESY_TITLE>Blue hat, green hat / Sandra Boynton</COURTESY_TITLE>
                <COURTESY_DUE_DATE>20110624</COURTESY_DUE_DATE>
                <COURTESY_RENEW_FLAG/>
            </COURTESY_ITEM>
        </COURTESY>
    </USER>
```

`<COURTESY_RENEWAL_FLAG>` has the following possible values
"DEFAULT" - Item is eligible for renewal
11 - Item is not eligible for renewal due to outstanding fees
12 - Item is not eligible for renewal patron Status is BLOCKED or BARRED
13 - Item is not eligible for renewal as item is on-hold
14 - Item is not eligible for renewal as maximum number renewals for the item has been reached

### _overdue_ – returns barcode and item barcode/title/due date/renew eligibility when querying a user barcode

https://server:port/cgi-bin/sb.cgi?report=overdue&uid=21967002133994

Input:

uid
: patron barcode number

Output:
```
    <USER>
        <USER_BARCODE>21967002133994</USER_BARCODE>
        <OVERDUE>
            <OVERDUE_ITEM>
                <OVERDUE_BARCODE>31967011342030</OVERDUE_BARCODE>
                <OVERDUE_ITEM_KEY>1399486:1:2</OVERDUE_ITEM_KEY>
                <OVERDUE_TITLE>End of days / Steve Alten</OVERDUE_TITLE>
                <OVERDUE_DUE_DATE>20110620</OVERDUE_DUE_DATE>
                <OVERDUE_RENEW_FLAG>13</OVERDUE_RENEW_FLAG>
            </OVERDUE_ITEM>
            <OVERDUE_ITEM>
                <OVERDUE_BARCODE>31967011066951</OVERDUE_BARCODE>
                <OVERDUE_ITEM_KEY>1399486:1:2</OVERDUE_ITEM_KEY>
                <OVERDUE_TITLE>Sworn to silence / Linda Castillo</OVERDUE_TITLE>
                <OVERDUE_DUE_DATE>20110620</OVERDUE_DUE_DATE>
                <OVERDUE_RENEW_FLAG>13</OVERDUE_RENEW_FLAG>
            </OVERDUE_ITEM>
        </OVERDUE>
    </USER>
```

`<OVERDUE_RENEWAL_FLAG>` has the following possible values
"DEFAULT" - Item is eligible for renewal
11 - Item is not eligible for renewal due to outstanding fees
12 - Item is not eligible for renewal patron Status is BLOCKED or BARRED
13 - Item is not eligible for renewal as item is on-hold
14 - Item is not eligible for renewal as maximum number renewals for the item has been reached
15 - Item is not eligible for renewal due to limit set on how many overdue items a patron can have at one time

### _overdue_ – returns user barcode/item barcode and charge status when querying a user barcode

https://server:port/cgi-bin/sb.cgi?report=chkcharge&uid=21967002133994&id=31967011342030

Input:    uid = patron barcode number
    id = item barcode number

Output:
```
    <ITEM>
        <ITEM_BARCODE>31967011342030</ITEM_BARCODE>
        <USER_BARCODE>21967002133994</USER_BARCODE>
        <CHARGED>0</CHARGED>
    </ITEM>
```

`<CHARGED>` has the following possible values:

0
: Item is not charged to patron
1
: Item is charged to patron

### _chkhold_ – returns item barcode and if item has a hold

https://server:port/cgi-bin/sb.cgi?report=chkhold&ikey=1399486:1:2

Input:

ikey
: item key number

Output:
```
    <ITEM>
        <ITEM_KEY>1399486:1:2</ITEM_KEY>
        <ONHOLD>0</ONHOLD>
    </ITEM>
```

`< ONHOLD>` has the following possible values:

0
: Item has no hold
1
: Item has a hold

### _fee_ – returns total fees linked to patron

https://server:port/cgi-bin/sb.cgi?report=fee&uid=21967002133994

Input: 

uid
: patron barcode number

Output:
```
    <USER>
        <USER_BARCODE>21967002133994<USER_BARCODE/>
        <FEES>
            <FEE_TOTAL>30.25</FEE_TOTAL>
        </FEES>
    </USER>
```

### _noticetype_ – returns patrons that requested notices via sms or voice

https://server:port/cgi-bin/sb.cgi?report=noticetype&type=sms

Input: 

type
: sms|voice

Output:
```
    <USER>
        <USER_INFO>
                  <USER_BARCODE>21168045392313</USER_BARCODE>
                  <USER_PHONENUMBER>5552221568</USER_ PHONENUMBER >
            </USER_INFO>
        <USER_INFO>
                  <USER_BARCODE>21168045392314</USER_BARCODE>
                  <USER_PHONENUMBER>5552221578</USER_ PHONENUMBER >
            </USER_INFO>
    </USER>
```

### _cancel_ – returns success or failure, when attempting to abandon a hold ready for pickup

https://server:port/cgi-bin/sb.cgi?report=cancel&uid=21967002133994&dbkey=1234566

Input:

uid
: patron barcode number
dbkey
: hold DB key

Output:
```
    <ITEM>
        <HOLD_CANCEL_STATUS>0</HOLD_CANCEL_STATUS>
    </ITEM>
```
`< HOLD_CANCEL_STATUS >` has the following possible values
0 – Cancel item hold failed
1 – Cancel item hold succeeded

### _holdexpiration_ – returns list of patron hold items that expired and not fulfilled

https://server:port/cgi-bin/sb.cgi?report=holdexpiration&date=20200817

Input: 

date
: date item hold request expired, YYYYMMDD

Output:
```
    <USER>
        <ITEM_INFO>
            <USER_BARCODE>21168045392313</USER_BARCODE>
            <ITEM_TITLE>Invisible Man</ITEM_TITLE >
         </ITEM_INFO>
        <ITEM_INFO>
            <USER_BARCODE>21168045392333</USER_BARCODE>
            <ITEM_TITLE>Invisible Woman</ITEM_TITLE >
         </ITEM_INFO>
    </USER>
```
