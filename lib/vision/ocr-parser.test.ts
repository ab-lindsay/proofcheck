import { describe, expect, it } from "vitest";
import { parseOcrText as parseOcrTextLines, type OcrLine } from "@/lib/vision/ocr-parser";
import { ExtractedLabelSchema } from "@/lib/schema";

// Test fixture builder: turns a list of line strings into OcrLine[] with a uniform default
// confidence/height. Most existing tests only care about which line's TEXT gets selected, not its
// bbox/confidence, so a uniform default keeps those tests unchanged. Tests that need to control a
// specific line's prominence (height) or confidence pass `opts` explicitly.
function mkLines(strings: string[], opts?: { heights?: number[]; confidences?: number[] }): OcrLine[] {
  return strings.map((text, i) => ({
    text,
    confidence: opts?.confidences?.[i] ?? 0.9,
    bbox: { x0: 0, y0: i * 20, x1: 500, y1: i * 20 + (opts?.heights?.[i] ?? 20) },
  }));
}

// Back-compat shim: every existing test below was written against the old (text: string, confidence:
// number) signature. This keeps those call sites unchanged; new tests that need to control a specific
// line's height/confidence call parseOcrTextLines directly with a hand-built OcrLine[].
function parseOcrText(text: string, _unusedOverallConfidence = 0.9): ReturnType<typeof parseOcrTextLines> {
  const strings = text.split("\n").filter((l) => l.trim() !== "");
  return parseOcrTextLines(mkLines(strings), text, 1000, 1000);
}

const OCR_TEXT = `OLD TOM DISTILLERY
Kentucky Straight Bourbon Whiskey
45% Alc./Vol. (90 Proof)
750 mL
Old Tom Distillery Co., Bardstown, KY
GOVERNMENT WARNING: (1) According to the Surgeon General, women should not
drink alcoholic beverages during pregnancy because of the risk of birth defects.
(2) Consumption of alcoholic beverages impairs your ability to drive a car or
operate machinery, and may cause health problems.`;

describe("parseOcrText", () => {
  it("finds the fields in plain OCR text", () => {
    const r = parseOcrText(OCR_TEXT, 0.9);
    expect(r.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(r.classType.value).toBe("Kentucky Straight Bourbon Whiskey");
    expect(r.alcoholContent.value).toContain("45%");
    expect(r.netContents.value).toContain("750");
    expect(r.nameAndAddress.value).toContain("Bardstown");
    expect(r.healthWarningStatement.value).toMatch(/^GOVERNMENT WARNING:/);
    expect(r.healthWarningStatement.value).toMatch(/health problems\.$/);
  });
  it("extracts the bare country from a PRODUCT OF line", () => {
    const r = parseOcrText("KIRKBRIDE CELLARS\nWhite Wine\nPRODUCT OF FRANCE\n750 mL", 0.8);
    expect(r.countryOfOrigin.value).toBe("FRANCE");
  });
  it("also recognizes IMPORTED FROM and PRODUCE OF country phrasings", () => {
    expect(parseOcrText("GLENN ROTHES\nScotch Whisky\nIMPORTED FROM SCOTLAND\n750 mL", 0.8).countryOfOrigin.value).toBe(
      "SCOTLAND",
    );
    expect(parseOcrText("VILLA ROSA\nRed Wine\nPRODUCE OF ITALY\n750 mL", 0.8).countryOfOrigin.value).toBe("ITALY");
  });
  it("joins words hyphenated across line breaks (real labels print MACHIN-ERY, AC-CORDING)", () => {
    const r = parseOcrText("GOVERNMENT WARNING: (1) AC-\nCORDING TO THE SURGEON GENERAL, WOMEN SHOULD NOT DRINK", 0.8);
    expect(r.healthWarningStatement.value).toContain("ACCORDING");
  });
  it("marks absent fields as not present with zero confidence", () => {
    const r = parseOcrText("SILVER CREST\nVodka\n40% Alc./Vol.\n750 mL", 0.8);
    expect(r.healthWarningStatement.present).toBe(false);
    expect(r.healthWarningStatement.confidence).toBe(0);
  });
  it("clamps a malformed bbox and returns a schema-valid label (invariant 2)", () => {
    const lines = mkLines(OCR_TEXT.split("\n"));
    // Simulate a degenerate Tesseract bbox (x1 < x0) on the brand line — must clamp to a zero-size
    // box, not throw out of BoundingBoxSchema.parse.
    lines[0] = { ...lines[0], bbox: { x0: 500, y0: 0, x1: 100, y1: 20 } };
    const r = parseOcrTextLines(lines, OCR_TEXT, 1000, 1000);
    for (const f of Object.values(r)) expect(Number.isFinite(f.confidence)).toBe(true);
    expect(() => ExtractedLabelSchema.parse(r)).not.toThrow();
    expect(r.brandName.boundingBox?.width).toBe(0);
  });
  it("does not append label text printed after the warning statement", () => {
    const withTrailer = OCR_TEXT + "\nIMPORTED BY ACME IMPORTS, NEW YORK, NY\nwww.example.com";
    const r = parseOcrText(withTrailer, 0.9);
    expect(r.healthWarningStatement.value).toMatch(/health problems\.$/);
    expect(r.healthWarningStatement.value).not.toContain("ACME");
  });
  it("does not misclassify a brand that contains a class-keyword substring", () => {
    const r = parseOcrText("VIRGINIA GENTLEMAN\nStraight Bourbon Whiskey\n40% Alc./Vol.\n750 mL", 0.9);
    expect(r.classType.value).toBe("Straight Bourbon Whiskey");
    expect(r.brandName.value).toBe("VIRGINIA GENTLEMAN");
  });
  it("does not read a street address as net contents", () => {
    const r = parseOcrText("SILVER CREST\nVodka\n40% Alc./Vol.\n1200 Larkspur Lane", 0.9);
    expect(r.netContents.present).toBe(false);
  });
  it("does not fabricate a brand from the warning body when the brand line is absent", () => {
    // Real OCR of a large bold title often drops it entirely, so no brand line exists. The brand must
    // not fall through to a warning-continuation line (e.g. "women should not drink...").
    const ocr = [
      "Kentucky Straight Bourbon Whiskey",
      "45% Alc./Vol. (90 Proof)",
      "750 mL",
      "Old Tom Distillery Co., Bardstown, KY",
      "GOVERNMENT WARNING: (1) According to the Surgeon General,",
      "women should not drink alcoholic beverages during pregnancy",
      "because of the risk of birth defects. (2) Consumption of",
      "alcoholic beverages impairs your ability to drive a car or",
      "operate machinery, and may cause health problems.",
    ].join("\n");
    const r = parseOcrText(ocr, 0.9);
    expect(r.brandName.value).toBeNull();
    expect(r.brandName.present).toBe(false);
  });
  it("captures only the country, not a trailing field word (bug C)", () => {
    const r = parseOcrText("CHATEAU EXAMPLE\nRed Wine\nProduct of France\nAlc. 13% by Vol.\n750 mL", 0.9);
    expect(r.countryOfOrigin.value).toBe("France");
  });
  it("selects period-abbreviated and spelled-out net contents (bug D)", () => {
    expect(parseOcrText("HARBOR POINT\nLager\n12 FL. OZ.", 0.9).netContents.value).toBe("12 FL. OZ.");
    expect(parseOcrText("NORTH BRAND\nVodka\n1.5 LITERS", 0.9).netContents.value).toBe("1.5 LITERS");
  });
  it("bounds the warning even when a stray space precedes the terminal period (bug E)", () => {
    const warned =
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems .";
    const r = parseOcrText(`${warned}\nIMPORTED BY ACME IMPORTS\nwww.example.com`, 0.9);
    expect(r.healthWarningStatement.value).not.toContain("ACME");
    expect(r.healthWarningStatement.value).not.toContain("example.com");
  });
  it("healthWarningStatement's fallback stops at a trailing website URL instead of appending it (Old-Tub-style)", () => {
    const text = [
      "GOVERNMENT WARNING: (1) ACCORDING TO THE SURGEON GENERAL, WOMEN SHOULD NOT DRINK ALCOHOLIC",
      "BEVERAGES DURING PREGNANCY BECAUSE OF THE RISK OF BIRTH DEFECTS (2) CONSUMPTION OF ALCOHOLIC",
      "BEVERAGES IMPAIRS YOUR ABILITY TO DRIVE A CAR OR OPERATE MACHINERY AND MAY CAUSE HEALTH",
      "PROBLEMS www.drinksmart.com 750 mL",
    ].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.healthWarningStatement.value).not.toContain("www.drinksmart.com");
    expect(r.healthWarningStatement.value).not.toContain("750 mL");
  });
  it("healthWarningStatement's fallback stops at a trailing barcode digit run instead of appending it", () => {
    const text = [
      "GOVERNMENT WARNING: (1) ACCORDING TO THE SURGEON GENERAL, WOMEN SHOULD NOT DRINK ALCOHOLIC",
      "BEVERAGES DURING PREGNANCY BECAUSE OF THE RISK OF BIRTH DEFECTS AND MAY CAUSE HEALTH",
      "PROBLEMS 80686176022",
    ].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.healthWarningStatement.value).not.toContain("80686176022");
  });
  it("healthWarningStatement still matches via the primary health-problems-anchored pattern when it closes cleanly (regression check)", () => {
    const text = [
      "GOVERNMENT WARNING: (1) ACCORDING TO THE SURGEON GENERAL, WOMEN SHOULD NOT DRINK ALCOHOLIC",
      "BEVERAGES DURING PREGNANCY BECAUSE OF THE RISK OF BIRTH DEFECTS. (2) CONSUMPTION OF ALCOHOLIC",
      "BEVERAGES IMPAIRS YOUR ABILITY TO DRIVE A CAR OR OPERATE MACHINERY, AND MAY CAUSE HEALTH",
      "PROBLEMS.",
    ].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.healthWarningStatement.value).toMatch(/HEALTH PROBLEMS\.$/);
  });
  it("does not fabricate a brand when GOVERNMENT and WARNING are on separate OCR lines (bug G)", () => {
    const ocr =
      "Kentucky Straight Bourbon Whiskey\n45% Alc./Vol. (90 Proof)\n750 mL\nGOVERNMENT\nWARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy.";
    const r = parseOcrText(ocr, 0.9);
    expect(r.brandName.value).toBeNull();
  });
  it("recognizes French producer and country phrasing, and strips the bottler verb phrase from nameAndAddress", () => {
    const r = parseOcrText(
      "DOMAINE LAURENT\nCôtes du Rhône Rouge\n13.5% Vol.\n750 mL\nMis en bouteille par Domaine Laurent, Vaison-la-Romaine\nProduit de France",
      0.8,
    );
    expect(r.classType.value).toBe("Côtes du Rhône Rouge");
    expect(r.nameAndAddress.value).toBe("Domaine Laurent, Vaison-la-Romaine");
    expect(r.countryOfOrigin.value).toBe("France");
  });
  it("recognizes Spanish producer and country phrasing, and strips the bottler verb phrase from nameAndAddress", () => {
    const r = parseOcrText(
      "BODEGA MONTALVO\nRioja Tinto\n13.5% Vol.\n750 mL\nEmbotellado por Bodega Montalvo, Haro\nProducto de España",
      0.8,
    );
    expect(r.classType.value).toBe("Rioja Tinto");
    expect(r.nameAndAddress.value).toBe("Bodega Montalvo, Haro");
    expect(r.countryOfOrigin.value).toBe("España");
  });
  it("recognizes Italian producer and country phrasing, and strips the bottler verb phrase from nameAndAddress", () => {
    const r = parseOcrText(
      "TENUTA ROSSINI\nChianti Rosso\n13% Vol.\n750 mL\nImbottigliato da Tenuta Rossini, Siena\nProdotto in Italia",
      0.8,
    );
    expect(r.classType.value).toBe("Chianti Rosso");
    expect(r.nameAndAddress.value).toBe("Tenuta Rossini, Siena");
    expect(r.countryOfOrigin.value).toBe("Italia");
  });
  it("recognizes Portuguese producer and country phrasing, and strips the bottler verb phrase from nameAndAddress", () => {
    const r = parseOcrText(
      "QUINTA DO VALE\nVinho Verde Branco\n11% Vol.\n750 mL\nEngarrafado por Quinta do Vale, Porto\nProduzido em Portugal",
      0.8,
    );
    expect(r.classType.value).toBe("Vinho Verde Branco");
    expect(r.nameAndAddress.value).toBe("Quinta do Vale, Porto");
    expect(r.countryOfOrigin.value).toBe("Portugal");
  });
  it("strips the English bottler verb phrase from nameAndAddress the same way (bug: was leaking 'Distilled and bottled by' into the matcher and forcing a false NON_COMPLIANT)", () => {
    const r = parseOcrText(
      "OLD TUB\nKentucky Straight Bourbon Whiskey\n50% Alc./Vol.\n750 mL\nDistilled and bottled by James B. Beam Distilling Co., Clermont, KY",
      0.9,
    );
    expect(r.nameAndAddress.value).toBe("James B. Beam Distilling Co., Clermont, KY");
  });
  it("does not strip anything from a 'Co.,'-style producer line (no verb phrase present)", () => {
    const r = parseOcrText(OCR_TEXT, 0.9);
    expect(r.nameAndAddress.value).toBe("Old Tom Distillery Co., Bardstown, KY");
  });
  it("nameAndAddress falls back to the next line when the producer verb phrase has nothing after it on its own line (Old-Tub-style)", () => {
    const text = [
      "OLD TUB",
      "BOURBON WHISKEY",
      "50% ALC./VOL.",
      "Distilled and Bottled by",
      "James B. Beam Distilling Co., Clermont, KY",
      "750 mL",
      "GOVERNMENT WARNING: text.",
    ].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.nameAndAddress.value).toBe("James B. Beam Distilling Co., Clermont, KY");
  });
  it("nameAndAddress is absent when the line after the verb phrase is the GOVERNMENT WARNING block (dropped company line must not capture the warning)", () => {
    const text = [
      "OLD TUB",
      "BOURBON WHISKEY",
      "50% ALC./VOL.",
      "750 mL",
      "Distilled and Bottled by",
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink.",
    ].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.nameAndAddress.value).toBeNull();
    expect(r.nameAndAddress.present).toBe(false);
  });
  it("nameAndAddress is absent when the verb phrase is the last OCR line — never the bare verb phrase (bottom-truncated photo)", () => {
    const text = ["OLD TUB", "BOURBON WHISKEY", "50% ALC./VOL.", "750 mL", "Distilled and Bottled by"].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.nameAndAddress.value).toBeNull();
    expect(r.nameAndAddress.present).toBe(false);
  });
  it("nameAndAddress still captures same-line text when the verb phrase and name share a line (regression check)", () => {
    const text = [
      "BUFFALO TRACE",
      "BOURBON WHISKEY",
      "45% ALC./VOL.",
      "Distilled and Bottled by Buffalo Trace Distillery Inc, Frankfort, KY",
      "750 mL",
      "GOVERNMENT WARNING: text.",
    ].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.nameAndAddress.value).toBe("Buffalo Trace Distillery Inc, Frankfort, KY");
  });

  // Models a real failure: a Guinness can's OCR produced two separate marketing-copy lines before
  // the real fields. Line 2 contains "beer" as an ordinary word, which used to win classType by
  // appearing before "DRAUGHT STOUT" (the real, much shorter class/type designation on the same
  // can). Line 1 contains no field keyword at all, so it used to win brandName by being the first
  // unclaimed leftover line, ahead of "GUINNESS" (see Task 2). Verified against the current
  // (pre-fix) parser: classType returns line 2 and brandName returns line 1 today.
  const GUINNESS_STYLE_OCR = `UPON OPENING, THE FAMOUS SURGE MAKES ITS WAY
THROUGH THE BEER, CREATING THE PERFECT PINT
GUINNESS
DRAUGHT STOUT
4.1% alc./vol.
14.9 FL. OZ.`;

  it("classType prefers the taller (more prominent) designation line over a longer line that incidentally contains the same keyword (Guinness-style)", () => {
    const strings = GUINNESS_STYLE_OCR.split("\n");
    // strings: [0] marketing line 1, [1] marketing line 2 (contains "beer"), [2] "GUINNESS",
    // [3] "DRAUGHT STOUT", [4] ABV, [5] net contents. DRAUGHT STOUT prints larger than the fine-print
    // marketing lines above it, same as the real can.
    const lines = mkLines(strings, { heights: [12, 12, 30, 24, 10, 10] });
    const r = parseOcrTextLines(lines, GUINNESS_STYLE_OCR, 1000, 1000);
    expect(r.classType.value).toBe("DRAUGHT STOUT");
  });

  it("brandName rejects a long comma-bearing marketing line and falls through to the real brand line (Guinness-style)", () => {
    const strings = GUINNESS_STYLE_OCR.split("\n");
    const lines = mkLines(strings, { heights: [12, 12, 30, 24, 10, 10] });
    const r = parseOcrTextLines(lines, GUINNESS_STYLE_OCR, 1000, 1000);
    expect(r.brandName.value).toBe("GUINNESS");
  });

  it("brandName does not fall back to a standardized designation like BOTTLED IN BOND when the real brand line is absent (Old-Tub-style)", () => {
    // Real OCR of a large stylized brand title is sometimes dropped entirely, leaving only a
    // standardized federal designation as the sole short, comma-free "leftover" candidate line.
    const oldTubStyleOcr = [
      "BOTTLED IN BOND",
      "KENTUCKY STRAIGHT BOURBON WHISKEY",
      "50% ALC./VOL. 100 PROOF",
      "750 mL",
      "Distilled and bottled by James B. Beam Distilling Co., Clermont, KY",
    ].join("\n");
    const r = parseOcrText(oldTubStyleOcr, 0.9);
    expect(r.brandName.value).toBeNull();
    expect(r.brandName.present).toBe(false);
  });

  // Modeled on real failures from degraded-photo eval fixtures: a garbled leftover line (short,
  // comma-free) used to sail through every other filter and be reported as a confident wrong brand
  // instead of an honest "not found." Each of these was the actual OCR output on a real bad image.
  it.each([
    ["100 PROOF 100 PROOF", "a duplicated proof restatement, not a brand"],
    ["World Spirits Competition!", "marketing copy with an exclamation point"],
    ["ROUND PLASTIC WIDGET IN EVERY =", "marketing copy trailing into a stray equals sign"],
    ["OL |", "a pipe artifact from a border line bleeding into the text"],
    ["y Mark:", "a garbled fragment with a stray colon"],
    ["* 00d. I's the", "asterisk and digit noise"],
    ["TENTUCR Y y RAIGH]T", "a stray bracket from heavy degradation"],
  ])("brandName rejects noisy leftover line %j (%s)", (noisyLine) => {
    const r = parseOcrText(`${noisyLine}\nKentucky Straight Bourbon Whiskey\n45% Alc./Vol.\n750 mL`, 0.9);
    expect(r.brandName.value).toBeNull();
  });

  it("brandName still finds a real short brand line and skips a noisy one further down", () => {
    const r = parseOcrText("OLD TUB\nEst. 1849\nKentucky Straight Bourbon Whiskey\n50% Alc./Vol.\n750 mL", 0.9);
    expect(r.brandName.value).toBe("OLD TUB");
  });

  it("brandName still finds the real brand line when it appears before the first structured field", () => {
    const text = ["REAL BRAND", "BOURBON WHISKEY", "50% ALC./VOL.", "750 mL", "GOVERNMENT WARNING: text."].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.brandName.value).toBe("REAL BRAND");
  });

  it("brandName resolves to null instead of a leftover line that appears after the first structured field (Old-Tub-style)", () => {
    // Models the real Old Tub failure: OCR dropped the actual brand entirely, leaving "100 PROOF 100
    // PROOF" (rejected by the existing digit-noise filter) and, after that, "KENTUCKY STRAIGHT" (a
    // truncated designation fragment) as the next unclaimed leftover line. Before this fix, the
    // parser fell through to "KENTUCKY STRAIGHT" as a confidently-wrong brand; after this fix, it
    // isn't even considered, because it appears after the first structured field (alcoholLine).
    const text = [
      "100 PROOF 100 PROOF",
      "BOURBON WHISKEY",
      "50% ALC./VOL.",
      "KENTUCKY STRAIGHT",
      "750 mL",
      "GOVERNMENT WARNING: text.",
    ].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.brandName.value).toBeNull();
    expect(r.brandName.present).toBe(false);
  });

  // BRAND_DENYLIST has five terms; the Old-Tub-style test above only exercises "BOTTLED IN BOND".
  // Cover the remaining four individually so a regex typo or anchoring bug in any one is caught.
  it.each([["SOUR MASH"], ["SINGLE BARREL"], ["SMALL BATCH"], ["CASK STRENGTH"]])(
    "brandName rejects the standardized designation %s when it is the only leftover candidate line",
    (designation) => {
      const ocr = [
        designation,
        "KENTUCKY STRAIGHT BOURBON WHISKEY",
        "50% ALC./VOL.",
        "750 mL",
        "Distilled and bottled by James B. Beam Distilling Co., Clermont, KY",
      ].join("\n");
      const r = parseOcrText(ocr, 0.9);
      expect(r.brandName.value).toBeNull();
    },
  );

  it("brandName rejects a comma-free leftover line longer than 6 words even without a denylist hit", () => {
    const r = parseOcrText(
      "THIS LEFTOVER LINE HAS EXACTLY EIGHT WORDS\nKentucky Straight Bourbon Whiskey\n45% Alc./Vol.\n750 mL",
      0.9,
    );
    expect(r.brandName.value).toBeNull();
  });

  it("brandName rejects a short (<=6 word) leftover line that contains a comma", () => {
    const r = parseOcrText("Est. 1849, Bardstown\nKentucky Straight Bourbon Whiskey\n45% Alc./Vol.\n750 mL", 0.9);
    expect(r.brandName.value).toBeNull();
  });

  it("classType prefers the earlier of two equal-length candidate lines (stable tie-break)", () => {
    const r = parseOcrText("RED WINE BLEND\nESTATE BOTTLED ALE\n13% Vol.\n750 mL", 0.9);
    expect(r.classType.value).toBe("RED WINE BLEND");
  });

  it.each([
    ["Côtes du Rhône Blanc", "blanc"],
    ["Rioja Blanco", "blanco"],
    ["Soave Bianco", "bianco"],
  ])("recognizes the white-wine class keyword in %s (%s)", (classLine) => {
    const r = parseOcrText(`DOMAINE EXAMPLE\n${classLine}\n12.5% Vol.\n750 mL`, 0.8);
    expect(r.classType.value).toBe(classLine);
  });

  it("classType prefers the taller varietal line over marketing prose containing an unrelated class keyword (Kunde-style)", () => {
    const strings = [
      "LA CREMA",
      "Kunde, a beloved wine-growing visionary, who planted the vineyard with her husband,",
      "CHARDONNAY",
      "13.5% Alc/Vol",
      "750 mL",
    ];
    // The marketing sentence contains "wine" as a whole word (matches CLASS_KEYWORDS) but prints as
    // small fine print; CHARDONNAY is the real, larger class/type designation.
    const lines = mkLines(strings, { heights: [30, 10, 26, 14, 14] });
    const r = parseOcrTextLines(lines, strings.join("\n"), 1000, 1000);
    expect(r.classType.value).toBe("CHARDONNAY");
  });

  it("alcoholContent rejects a %-line with no ABV context and falls through to the real ABV line (La-Crema-style)", () => {
    const text = [
      "LA CREMA",
      "CHARDONNAY",
      "AGED MINIMUM OF 9 MONTHS IN 100% FRENCH OAK",
      "13.5% Alc/Vol",
      "750 mL",
    ].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.alcoholContent.value).toBe("13.5% Alc/Vol");
  });

  it("alcoholContent resolves to null instead of a %-line with no ABV context when no real ABV line exists", () => {
    const text = ["LA CREMA", "CHARDONNAY", "AGED MINIMUM OF 9 MONTHS IN 100% FRENCH OAK", "750 mL"].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.alcoholContent.value).toBeNull();
  });

  it("alcoholContent still matches a bare proof line with no percent sign (regression check)", () => {
    const text = ["OLD TOM", "BOURBON WHISKEY", "100 PROOF", "750 mL"].join("\n");
    const r = parseOcrText(text, 0.9);
    expect(r.alcoholContent.value).toBe("100 PROOF");
  });

  it("a field's confidence reflects its own line, not a high confidence elsewhere on the page", () => {
    // Regression test for "confident-wrong beats honest-uncertain": a garbled brand line sitting in
    // an otherwise-decent scan must not inherit the other lines' high confidence.
    const lines = mkLines(["GARBLED BRAND", "Kentucky Straight Bourbon Whiskey", "45% Alc./Vol.", "750 mL"], {
      confidences: [0.2, 0.95, 0.95, 0.95],
    });
    const r = parseOcrTextLines(lines, lines.map((l) => l.text).join("\n"), 1000, 1000);
    expect(r.brandName.value).toBe("GARBLED BRAND");
    expect(r.brandName.confidence).toBe(0.2);
    expect(r.classType.confidence).toBe(0.95);
  });

  it("multi-line nameAndAddress confidence is the minimum across its contributing lines", () => {
    const lines = mkLines(
      [
        "OLD TUB",
        "BOURBON WHISKEY",
        "50% ALC./VOL.",
        "Distilled and Bottled by",
        "James B. Beam Distilling Co., Clermont, KY",
        "750 mL",
      ],
      { confidences: [0.9, 0.9, 0.9, 0.9, 0.4, 0.9] },
    );
    const r = parseOcrTextLines(lines, lines.map((l) => l.text).join("\n"), 1000, 1000);
    expect(r.nameAndAddress.value).toBe("James B. Beam Distilling Co., Clermont, KY");
    expect(r.nameAndAddress.confidence).toBe(0.4);
  });

  it("populates boundingBox as the image-fraction rectangle of the selected line", () => {
    const lines: OcrLine[] = [
      { text: "OLD TOM DISTILLERY", confidence: 0.9, bbox: { x0: 100, y0: 50, x1: 900, y1: 150 } },
      { text: "750 mL", confidence: 0.9, bbox: { x0: 100, y0: 400, x1: 300, y1: 440 } },
    ];
    const r = parseOcrTextLines(lines, lines.map((l) => l.text).join("\n"), 1000, 500);
    expect(r.brandName.boundingBox).toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.2 });
  });

  it("healthWarningStatement confidence is the minimum across the lines it actually spans, not the whole page", () => {
    const text = [
      "OLD TOM DISTILLERY",
      "Kentucky Straight Bourbon Whiskey",
      "45% Alc./Vol.",
      "750 mL",
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not",
      "drink alcoholic beverages during pregnancy because of the risk of birth defects.",
      "(2) Consumption of alcoholic beverages impairs your ability to drive a car or",
      "operate machinery, and may cause health problems.",
      "IMPORTED BY ACME IMPORTS, NEW YORK, NY",
    ];
    const lines = mkLines(text, { confidences: [0.9, 0.9, 0.9, 0.9, 0.9, 0.3, 0.9, 0.9, 0.9] });
    const r = parseOcrTextLines(lines, text.join("\n"), 1000, 1000);
    expect(r.healthWarningStatement.value).toMatch(/health problems\.$/);
    // The trailing importer line (index 8, confidence irrelevant) must not be included — only the 4
    // warning lines (indices 4-7) contribute, so the minimum among THEM (0.3) is the field's confidence.
    expect(r.healthWarningStatement.confidence).toBe(0.3);
  });

  it("brandName picks the taller candidate over an earlier, shorter one", () => {
    // "Est. Since 1849" has a digit -> already rejected by BRAND_NOISE regardless of height, so use a
    // shape-plausible-but-wrong earlier candidate instead: a short, comma-free, low-prominence line.
    const withValidEarlierCandidate = [
      "Fine Spirits",
      "REAL BRAND NAME",
      "Kentucky Straight Bourbon Whiskey",
      "45% Alc./Vol.",
      "750 mL",
    ];
    const lines = mkLines(withValidEarlierCandidate, { heights: [10, 40, 20, 14, 14] });
    const r = parseOcrTextLines(lines, withValidEarlierCandidate.join("\n"), 1000, 1000);
    expect(r.brandName.value).toBe("REAL BRAND NAME");
  });

  it("healthWarningStatement resolves to not-found, not an inconsistent present:false-with-a-value, when GOVERNMENT itself is split across lines", () => {
    // Dehyphenation reconnects "GOVERN-\nMENT" into "GOVERNMENT" in fullText (so warningMatch finds a
    // value), but no single OCR line contains the literal word "GOVERNMENT", so warningStart is -1 and
    // no lines back the confidence. Value and present must stay coherent rather than returning a
    // non-null value with present:false.
    const lines: OcrLine[] = [
      { text: "OLD TOM DISTILLERY", confidence: 0.9, bbox: { x0: 0, y0: 0, x1: 200, y1: 20 } },
      { text: "GOVERN-", confidence: 0.9, bbox: { x0: 0, y0: 40, x1: 200, y1: 60 } },
      {
        text: "MENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
        confidence: 0.9,
        bbox: { x0: 0, y0: 60, x1: 200, y1: 80 },
      },
    ];
    const fullText = lines.map((l) => l.text).join("\n");
    const r = parseOcrTextLines(lines, fullText, 1000, 1000);
    expect(r.healthWarningStatement.value).toBeNull();
    expect(r.healthWarningStatement.present).toBe(false);
  });
});
