// "What you can write" in a mapping rule: every phrase the built-in interpreter understands, grouped, each with an
// example, the expression it becomes and its result on SAMPLE. The Factory shows this list; the runtime tests compile
// every example and check the expression and the result, so the list can never promise more than the interpreter does.
// Generated from the interpreter on the server (see apps/weave-runtime/test/phrases.test.ts); edit both together.
import type { Json } from "./types.js";

export interface MappingPhrase { group: string; phrase: string; example: string; expr: string; value: Json; }

/** The sample every example below is computed on. */
export const MAPPING_PHRASE_SAMPLE: Json = {"data": {"email": "jane.doe@example.invalid", "channel": "web", "first": "jane", "last": "doe", "name": "  jane doe ", "code": "M", "amount": "1234.567", "qty": 3, "date": "2026-01-31", "status": "A", "active": "yes", "missing": "", "tags": ["vip", "gift", "vip"], "items": [{"sku": "X1", "price": 10, "type": "a"}, {"sku": "Y2", "price": 25, "type": "b"}, {"sku": "Z3", "price": 5, "type": "a"}]}};

export const MAPPING_PHRASES: MappingPhrase[] = [
 {
  "group": "Text in front or behind",
  "phrase": "add \"TEXT\" before FIELD",
  "example": "add \"New\" before data.channel",
  "expr": "\"New \" & data.channel",
  "value": "New web"
 },
 {
  "group": "Text in front or behind",
  "phrase": "add \"TEXT\" after FIELD",
  "example": "add \"Online\" after data.channel",
  "expr": "data.channel & \" Online\"",
  "value": "web Online"
 },
 {
  "group": "Text in front or behind",
  "phrase": "prefix FIELD with \"TEXT-\" (separator: no space)",
  "example": "prefix data.channel with \"CH-\"",
  "expr": "\"CH-\" & data.channel",
  "value": "CH-web"
 },
 {
  "group": "Text in front or behind",
  "phrase": "add \"TEXT\" before FIELD without a space",
  "example": "add \"New\" before data.channel without a space",
  "expr": "\"New\" & data.channel",
  "value": "Newweb"
 },
 {
  "group": "Text in front or behind",
  "phrase": "\"TEXT\" + FIELD (no space)",
  "example": "\"New\" + data.channel",
  "expr": "\"New\" & data.channel",
  "value": "Newweb"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is \"X\" then \"A\" otherwise \"B\"",
  "example": "if data.status is \"A\" then \"Active\" otherwise \"Other\"",
  "expr": "data.status = \"A\" ? \"Active\" : \"Other\"",
  "value": "Active"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is not \"X\" then …",
  "example": "if data.status is not \"A\" then \"Other\" otherwise \"Active\"",
  "expr": "data.status != \"A\" ? \"Other\" : \"Active\"",
  "value": "Active"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD contains \"X\" then …",
  "example": "if data.email contains \"@\" then \"valid\" otherwise \"invalid\"",
  "expr": "$contains(data.email, \"@\") ? \"valid\" : \"invalid\"",
  "value": "valid"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD starts with \"X\" then …",
  "example": "if data.email starts with \"jane\" then \"yes\" otherwise \"no\"",
  "expr": "$substring(data.email, 0, 4) = \"jane\" ? \"yes\" : \"no\"",
  "value": "yes"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD ends with \"X\" then …",
  "example": "if data.email ends with \".invalid\" then \"test\" otherwise \"real\"",
  "expr": "$substring(data.email, -8) = \".invalid\" ? \"test\" : \"real\"",
  "value": "test"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is greater than N then …",
  "example": "if data.qty is greater than 2 then \"many\" otherwise \"few\"",
  "expr": "data.qty > 2 ? \"many\" : \"few\"",
  "value": "many"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is less than or equal to N then …",
  "example": "if data.qty is less than or equal to 3 then \"small\" otherwise \"large\"",
  "expr": "data.qty <= 3 ? \"small\" : \"large\"",
  "value": "small"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is at least N then …",
  "example": "if data.qty is at least 3 then \"ok\" otherwise \"too few\"",
  "expr": "data.qty >= 3 ? \"ok\" : \"too few\"",
  "value": "ok"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is between N and M then …",
  "example": "if data.qty is between 1 and 5 then \"in range\" otherwise \"out of range\"",
  "expr": "data.qty >= 1 and data.qty <= 5 ? \"in range\" : \"out of range\"",
  "value": "in range"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is one of \"X\", \"Y\" then …",
  "example": "if data.status is one of \"A\", \"B\" then \"known\" otherwise \"unknown\"",
  "expr": "data.status in [\"A\", \"B\"] ? \"known\" : \"unknown\"",
  "value": "known"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is empty then … otherwise …",
  "example": "if data.missing is empty then \"none\" otherwise data.missing",
  "expr": "$coalesce(data.missing, \"none\")",
  "value": "none"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD is not empty then …",
  "example": "if data.channel is not empty then \"has channel\" otherwise \"no channel\"",
  "expr": "$not($isEmpty(data.channel)) ? \"has channel\" : \"no channel\"",
  "value": "has channel"
 },
 {
  "group": "Conditions",
  "phrase": "if FIELD matches pattern \"REGEX\" then …",
  "example": "if data.email matches pattern \"^[a-z.]+@\" then \"ok\" otherwise \"bad\"",
  "expr": "$contains(data.email, /^[a-z.]+@/) ? \"ok\" : \"bad\"",
  "value": "ok"
 },
 {
  "group": "Conditions",
  "phrase": "if … and … then …",
  "example": "if data.status is \"A\" and data.qty is greater than 1 then \"go\" otherwise \"stop\"",
  "expr": "data.status = \"A\" and data.qty > 1 ? \"go\" : \"stop\"",
  "value": "go"
 },
 {
  "group": "Conditions",
  "phrase": "if … or … then …",
  "example": "if data.status is \"B\" or data.qty is greater than 1 then \"go\" otherwise \"stop\"",
  "expr": "data.status = \"B\" or data.qty > 1 ? \"go\" : \"stop\"",
  "value": "go"
 },
 {
  "group": "Conditions",
  "phrase": "if not … then …",
  "example": "if not data.status is \"B\" then \"not B\" otherwise \"B\"",
  "expr": "$not(data.status = \"B\") ? \"not B\" : \"B\"",
  "value": "not B"
 },
 {
  "group": "When there is no value",
  "phrase": "use \"X\" when FIELD is empty",
  "example": "use \"N/A\" when data.missing is empty",
  "expr": "$coalesce(data.missing, \"N/A\")",
  "value": "N/A"
 },
 {
  "group": "When there is no value",
  "phrase": "FIELD or \"X\"",
  "example": "data.missing or \"N/A\"",
  "expr": "$coalesce(data.missing, \"N/A\")",
  "value": "N/A"
 },
 {
  "group": "When there is no value",
  "phrase": "use FIELD or FIELD2",
  "example": "use data.missing or data.channel",
  "expr": "$coalesce(data.missing, data.channel)",
  "value": "web"
 },
 {
  "group": "Lists",
  "phrase": "LIST where FIELD is \"X\" (filter)",
  "example": "data.items where type is \"a\"",
  "expr": "data.items[type = \"a\"]",
  "value": [
   {
    "sku": "X1",
    "price": 10,
    "type": "a"
   },
   {
    "sku": "Z3",
    "price": 5,
    "type": "a"
   }
  ]
 },
 {
  "group": "Lists",
  "phrase": "filter LIST where FIELD is greater than N",
  "example": "filter data.items where price is greater than 8",
  "expr": "data.items[price > 8]",
  "value": [
   {
    "sku": "X1",
    "price": 10,
    "type": "a"
   },
   {
    "sku": "Y2",
    "price": 25,
    "type": "b"
   }
  ]
 },
 {
  "group": "Lists",
  "phrase": "first item of LIST where …",
  "example": "first item of data.items where type is \"a\"",
  "expr": "(data.items[type = \"a\"])[0]",
  "value": {
   "sku": "X1",
   "price": 10,
   "type": "a"
  }
 },
 {
  "group": "Lists",
  "phrase": "last item of LIST where …",
  "example": "last item of data.items where type is \"a\"",
  "expr": "(data.items[type = \"a\"])[-1]",
  "value": {
   "sku": "Z3",
   "price": 5,
   "type": "a"
  }
 },
 {
  "group": "Lists",
  "phrase": "count of LIST",
  "example": "count of data.items",
  "expr": "$count(data.items)",
  "value": 3
 },
 {
  "group": "Lists",
  "phrase": "sum of LIST.FIELD",
  "example": "sum of data.items.price",
  "expr": "$sum(data.items.price)",
  "value": 40
 },
 {
  "group": "Lists",
  "phrase": "average of LIST.FIELD",
  "example": "average of data.items.price",
  "expr": "$average(data.items.price)",
  "value": 13.333333333333334
 },
 {
  "group": "Lists",
  "phrase": "max of LIST.FIELD",
  "example": "max of data.items.price",
  "expr": "$max(data.items.price)",
  "value": 25
 },
 {
  "group": "Lists",
  "phrase": "min of LIST.FIELD",
  "example": "min of data.items.price",
  "expr": "$min(data.items.price)",
  "value": 5
 },
 {
  "group": "Lists",
  "phrase": "sort LIST by FIELD",
  "example": "sort data.items by price",
  "expr": "$sort(data.items, function($l, $r) { $l.price > $r.price })",
  "value": [
   {
    "sku": "Z3",
    "price": 5,
    "type": "a"
   },
   {
    "sku": "X1",
    "price": 10,
    "type": "a"
   },
   {
    "sku": "Y2",
    "price": 25,
    "type": "b"
   }
  ]
 },
 {
  "group": "Lists",
  "phrase": "sort LIST by FIELD descending",
  "example": "sort data.items by price descending",
  "expr": "$sort(data.items, function($l, $r) { $l.price < $r.price })",
  "value": [
   {
    "sku": "Y2",
    "price": 25,
    "type": "b"
   },
   {
    "sku": "X1",
    "price": 10,
    "type": "a"
   },
   {
    "sku": "Z3",
    "price": 5,
    "type": "a"
   }
  ]
 },
 {
  "group": "Lists",
  "phrase": "unique LIST (remove duplicates)",
  "example": "unique data.tags",
  "expr": "$distinct(data.tags)",
  "value": [
   "vip",
   "gift"
  ]
 },
 {
  "group": "Lists",
  "phrase": "group LIST by FIELD",
  "example": "group data.items by type",
  "expr": "data.items{type: [$]}",
  "value": {
   "a": [
    {
     "sku": "X1",
     "price": 10,
     "type": "a"
    },
    {
     "sku": "Z3",
     "price": 5,
     "type": "a"
    }
   ],
   "b": [
    {
     "sku": "Y2",
     "price": 25,
     "type": "b"
    }
   ]
  }
 },
 {
  "group": "Lists",
  "phrase": "join LIST with \",\"",
  "example": "join data.tags with \",\"",
  "expr": "$join(data.tags, \",\")",
  "value": "vip,gift,vip"
 },
 {
  "group": "Lists",
  "phrase": "split FIELD by \"X\"",
  "example": "split data.email by \"@\"",
  "expr": "$split(data.email, \"@\")",
  "value": [
   "jane.doe",
   "example.invalid"
  ]
 },
 {
  "group": "Text",
  "phrase": "FIELD in uppercase",
  "example": "data.channel in uppercase",
  "expr": "$uppercase(data.channel)",
  "value": "WEB"
 },
 {
  "group": "Text",
  "phrase": "FIELD in lowercase",
  "example": "data.status in lowercase",
  "expr": "$lowercase(data.status)",
  "value": "a"
 },
 {
  "group": "Text",
  "phrase": "FIELD in title case",
  "example": "data.first in title case",
  "expr": "$titleCase(data.first)",
  "value": "Jane"
 },
 {
  "group": "Text",
  "phrase": "trim FIELD",
  "example": "trim data.name",
  "expr": "$trim(data.name)",
  "value": "jane doe"
 },
 {
  "group": "Text",
  "phrase": "first N characters of FIELD",
  "example": "first 4 characters of data.email",
  "expr": "$substring(data.email, 0, 4)",
  "value": "jane"
 },
 {
  "group": "Text",
  "phrase": "substring of FIELD from N to M",
  "example": "substring of data.email from 1 to 4",
  "expr": "$substring(data.email, 0, 4)",
  "value": "jane"
 },
 {
  "group": "Text",
  "phrase": "replace \"X\" with \"Y\" in FIELD",
  "example": "replace \".\" with \"-\" in data.email",
  "expr": "$replace(data.email, \".\", \"-\")",
  "value": "jane-doe@example-invalid"
 },
 {
  "group": "Text",
  "phrase": "remove everything after \"X\" in FIELD",
  "example": "remove everything after \"@\" in data.email",
  "expr": "$substringBefore(data.email, \"@\")",
  "value": "jane.doe"
 },
 {
  "group": "Text",
  "phrase": "remove everything before \"X\" in FIELD",
  "example": "remove everything before \"@\" in data.email",
  "expr": "$substringAfter(data.email, \"@\")",
  "value": "example.invalid"
 },
 {
  "group": "Text",
  "phrase": "join FIELD and FIELD2 with \" \"",
  "example": "join data.first and data.last with \" \"",
  "expr": "data.first & \" \" & data.last",
  "value": "jane doe"
 },
 {
  "group": "Text",
  "phrase": "concatenate FIELD, FIELD2 and FIELD3",
  "example": "concatenate data.first, data.status and data.code",
  "expr": "data.first & data.status & data.code",
  "value": "janeAM"
 },
 {
  "group": "Dates",
  "phrase": "format FIELD as \"DD/MM/YYYY\"",
  "example": "format data.date as \"DD/MM/YYYY\"",
  "expr": "$formatDate(data.date, \"DD/MM/YYYY\")",
  "value": "31/01/2026"
 },
 {
  "group": "Dates",
  "phrase": "parse FIELD (as a date)",
  "example": "parse data.date",
  "expr": "$parseDate(data.date)",
  "value": "2026-01-31T00:00:00.000Z"
 },
 {
  "group": "Dates",
  "phrase": "add N days to FIELD",
  "example": "add 5 days to data.date",
  "expr": "$addTime(data.date, 5, \"days\")",
  "value": "2026-02-05"
 },
 {
  "group": "Numbers",
  "phrase": "round FIELD to N decimals",
  "example": "round data.amount to 2 decimals",
  "expr": "$round($number(data.amount), 2)",
  "value": 1234.57
 },
 {
  "group": "Numbers",
  "phrase": "format FIELD as number with N decimals",
  "example": "format data.amount as number with 2 decimals",
  "expr": "$formatNumber($number(data.amount), \"0.00\")",
  "value": "1234.57"
 },
 {
  "group": "Numbers",
  "phrase": "format FIELD with N decimals and thousands separators",
  "example": "format data.amount with 2 decimals and thousands separators",
  "expr": "$formatNumber($number(data.amount), \"#,##0.00\")",
  "value": "1,234.57"
 },
 {
  "group": "Types",
  "phrase": "FIELD as number",
  "example": "data.amount as number",
  "expr": "$number(data.amount)",
  "value": 1234.567
 },
 {
  "group": "Types",
  "phrase": "FIELD as text",
  "example": "data.qty as text",
  "expr": "$string(data.qty)",
  "value": "3"
 },
 {
  "group": "Types",
  "phrase": "FIELD as true or false (yes, 1, on…)",
  "example": "data.active as boolean",
  "expr": "$toBool(data.active)",
  "value": true
 },
 {
  "group": "Lookup",
  "phrase": "X means A, Y means B (FIELD)",
  "example": "M means Male, F means Female (data.code)",
  "expr": "$translate(data.code, {\"M\": \"Male\", \"F\": \"Female\"})",
  "value": "Male"
 },
 {
  "group": "Objects",
  "phrase": "build an object with KEY from FIELD and KEY2 from FIELD2",
  "example": "build an object with channel from data.channel and mail from data.email",
  "expr": "{\"channel\": data.channel, \"mail\": data.email}",
  "value": {
   "channel": "web",
   "mail": "jane.doe@example.invalid"
  }
 }
];

/** How text is joined when it is put in front of or behind a value. */
export const JOIN_RULE = "A word put in front of or behind a value is separated by one space (\"New\" before web gives \"New web\"). Text that already ends (or starts) with a separator such as - / _ : . is joined directly, and so is everything when you write \"without a space\" or use +.";
