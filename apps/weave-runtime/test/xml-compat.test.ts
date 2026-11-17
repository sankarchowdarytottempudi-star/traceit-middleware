// Pins $xmlToJson / $jsonToXml output. The expected values were captured with fast-xml-parser 4.5.0
// before the upgrade to 5.x, so a parser upgrade that changes what flows see fails here.
import { describe, expect, it } from "vitest";
import { evalExpr, jsonToXml, xmlToJson } from "../src/expr.js";

const parseCases: Record<string, string> = {
  attributes: `<order id="42" status="open"><customer type="vip">Ada</customer></order>`,
  arrays: `<list><item>a</item><item>b</item><item n="3">c</item></list>`,
  cdata: `<msg><body><![CDATA[<b>bold</b> & raw]]></body><note>x</note></msg>`,
  namespaces: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="urn:x"><soap:Body><m:GetPrice m:cur="USD"><m:Item>Apple</m:Item></m:GetPrice></soap:Body></soap:Envelope>`,
  declarationAndComments: `<?xml version="1.0" encoding="UTF-8"?><!-- c --><root><a> 1 </a><b>true</b><c>007</c></root>`,
  entities: `<t a="x &amp; y">&lt;tag&gt; &quot;q&quot; &apos;s&apos; &amp;</t>`,
  emptyAndSelfClosing: `<r><e/><f></f><g a="1"/></r>`,
  mixed: `<p class="c">Hello <b>world</b> again</p>`,
  nestedArrays: `<a><b><c>1</c><c>2</c></b><b><c>3</c></b></a>`,
  numbersStayText: `<n><i>12</i><f>1.50</f><x>1e3</x><h>0x1F</h><neg>-4</neg></n>`,
  whitespace: `<w>\n  <v>  padded  </v>\n</w>`,
  unicode: `<u name="Zoë">مرحبا ✓</u>`,
};
const buildCases: Record<string, unknown> = {
  attrs: { order: { "@id": "42", customer: { "@type": "vip", "#text": "Ada" } } },
  arrays: { list: { item: ["a", "b", { "@n": "3", "#text": "c" }] } },
  empty: { r: { e: "", f: {}, g: { "@a": "1" }, h: null } },
  scalars: { s: { n: 12, f: 1.5, b: true, z: 0 } },
  namespaces: { "soap:Envelope": { "@xmlns:soap": "http://schemas.xmlsoap.org/soap/envelope/", "soap:Body": { "m:Item": "Apple" } } },
  escaping: { t: { "@a": "x & y \"q\"", "#text": "<tag> & single" } },
  nested: { a: { b: [{ c: ["1", "2"] }, { c: "3" }] } },
  topArray: [{ a: "1" }, { b: "2" }],
};
const expected = {
 "parse": {
  "attributes": {
   "order": {
    "customer": {
     "#text": "Ada",
     "@type": "vip"
    },
    "@id": "42",
    "@status": "open"
   }
  },
  "arrays": {
   "list": {
    "item": [
     "a",
     "b",
     {
      "#text": "c",
      "@n": "3"
     }
    ]
   }
  },
  "cdata": {
   "msg": {
    "body": "<b>bold</b> & raw",
    "note": "x"
   }
  },
  "namespaces": {
   "soap:Envelope": {
    "soap:Body": {
     "m:GetPrice": {
      "m:Item": "Apple",
      "@m:cur": "USD"
     }
    },
    "@xmlns:soap": "http://schemas.xmlsoap.org/soap/envelope/",
    "@xmlns:m": "urn:x"
   }
  },
  "declarationAndComments": {
   "?xml": {
    "@version": "1.0",
    "@encoding": "UTF-8"
   },
   "root": {
    "a": "1",
    "b": "true",
    "c": "007"
   }
  },
  "entities": {
   "t": {
    "#text": "<tag> \"q\" 's' &",
    "@a": "x & y"
   }
  },
  "emptyAndSelfClosing": {
   "r": {
    "e": "",
    "f": "",
    "g": {
     "@a": "1"
    }
   }
  },
  "mixed": {
   "p": {
    "b": "world",
    "#text": "Helloagain",
    "@class": "c"
   }
  },
  "nestedArrays": {
   "a": {
    "b": [
     {
      "c": [
       "1",
       "2"
      ]
     },
     {
      "c": "3"
     }
    ]
   }
  },
  "numbersStayText": {
   "n": {
    "i": "12",
    "f": "1.50",
    "x": "1e3",
    "h": "0x1F",
    "neg": "-4"
   }
  },
  "whitespace": {
   "w": {
    "v": "padded"
   }
  },
  "unicode": {
   "u": {
    "#text": "مرحبا ✓",
    "@name": "Zoë"
   }
  }
 },
 "build": {
  "attrs": "<order id=\"42\"><customer type=\"vip\">Ada</customer></order>",
  "arrays": "<list><item>a</item><item>b</item><item n=\"3\">c</item></list>",
  "empty": "<r><e/><f/><g a=\"1\"/><h/></r>",
  "scalars": "<s><n>12</n><f>1.5</f><b>true</b><z>0</z></s>",
  "namespaces": "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body><m:Item>Apple</m:Item></soap:Body></soap:Envelope>",
  "escaping": "<t a=\"x &amp; y &quot;q&quot;\">&lt;tag&gt; &amp; single</t>",
  "nested": "<a><b><c>1</c><c>2</c></b><b><c>3</c></b></a>",
  "topArray": "<0><a>1</a></0><1><b>2</b></1>"
 },
 "roundTrip": {
  "attributes": "<order id=\"42\" status=\"open\"><customer type=\"vip\">Ada</customer></order>",
  "arrays": "<list><item>a</item><item>b</item><item n=\"3\">c</item></list>",
  "cdata": "<msg><body>&lt;b&gt;bold&lt;/b&gt; &amp; raw</body><note>x</note></msg>",
  "namespaces": "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:m=\"urn:x\"><soap:Body><m:GetPrice m:cur=\"USD\"><m:Item>Apple</m:Item></m:GetPrice></soap:Body></soap:Envelope>",
  "declarationAndComments": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><root><a>1</a><b>true</b><c>007</c></root>",
  "entities": "<t a=\"x &amp; y\">&lt;tag&gt; &quot;q&quot; &apos;s&apos; &amp;</t>",
  "emptyAndSelfClosing": "<r><e/><f/><g a=\"1\"/></r>",
  "mixed": "<p class=\"c\"><b>world</b>Helloagain</p>",
  "nestedArrays": "<a><b><c>1</c><c>2</c></b><b><c>3</c></b></a>",
  "numbersStayText": "<n><i>12</i><f>1.50</f><x>1e3</x><h>0x1F</h><neg>-4</neg></n>",
  "whitespace": "<w><v>padded</v></w>",
  "unicode": "<u name=\"Zoë\">مرحبا ✓</u>"
 }
};

describe("xml <-> json stays as it was", () => {
  it.each(Object.keys(parseCases))("parses %s", (k) => {
    expect(xmlToJson(parseCases[k])).toEqual((expected.parse as Record<string, unknown>)[k]);
  });
  it.each(Object.keys(buildCases))("builds %s", (k) => {
    expect(jsonToXml(buildCases[k])).toBe((expected.build as Record<string, string>)[k]);
  });
  it.each(Object.keys(parseCases))("round-trips %s", (k) => {
    expect(jsonToXml(xmlToJson(parseCases[k]))).toBe((expected.roundTrip as Record<string, string>)[k]);
  });
  it("is reachable from expressions", async () => {
    const scope = { payload: { x: parseCases.attributes } } as never;
    expect(await evalExpr("$xmlToJson(x).order.customer.`@type`", scope)).toBe("vip");
    expect(await evalExpr('$jsonToXml({"a": {"@id": "1", "#text": "x"}})', scope)).toBe('<a id="1">x</a>');
  });
  it("does not expand entities declared in a DOCTYPE into a huge value", () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]><r>&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;</r>';
    let out: unknown;
    try { out = xmlToJson(bomb); } catch { out = "rejected"; }
    expect(JSON.stringify(out ?? "").length).toBeLessThan(20_000);
  });
});
