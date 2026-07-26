# Eval sample sources — TTB Public COLA Registry

Real approved labels downloaded from TTB's [Public COLA Registry](https://www.ttb.gov/regulated-commodities/labeling/cola-public-registry)
([search UI](https://www.ttbonline.gov/colasonline/publicSearchColasBasic.do)) on 2026-07-21.
Free, public, no registration. 10 COLAs (17 image files): 4 distilled spirits, 3 wine, 3 malt beverage.

Ground truth below is **as printed on the label images** (verified visually), with registry metadata
from each COLA's public detail page. This file is raw material only — the eval fixture schema
(`expected.json`) is defined by the implementation plan, not here.

**Warning-statement case (QA-verified at zoom, 2026-07-21):** every label here prints the warning
*body* in ALL CAPS **except Maker's Mark**, whose body is sentence case — the only one matching the
canonical § 16.21 text case-for-case. Plant registry numbers (DSP-/BW-) come from registry metadata
and are **not printed** on the labels except Old Tub's DSP-KY-230.

## How these were fetched (for re-fetching / adding samples)

All URLs are on `https://www.ttbonline.gov/colasonline/`:

1. `publicSearchColasBasic.do` (GET) — warms the session; the site sits behind an F5 TSPD
   JS challenge that intermittently serves a challenge page. A cookie jar + retry (2nd request
   usually passes) gets through. The server also omits its TLS intermediate cert
   (`Entrust OV TLS Issuing RSA CA 2`, AIA: http://crt.sectigo.com/EntrustOVTLSIssuingRSACA2.crt);
   append it to the CA bundle for curl.
2. `publicSearchColasBasicProcess.do?action=search` (POST) — fields
   `searchCriteria.dateCompletedFrom/To` (MM/DD/YYYY), `searchCriteria.productOrFancifulName`
   (`%` wildcard supported), `searchCriteria.productNameSearchType` (`B` brand / `F` fanciful / `E` either).
   Name match is exact unless wildcarded.
3. `viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=<TTBID>` — the permalink detail page
   (registry metadata, no images).
4. `viewColaDetails.do?action=publicFormDisplay&ttbid=<TTBID>` — the printable Form 5100.31 view;
   its `<img>` tags carry the label attachment URLs.
5. `publicViewAttachment.do?filename=<name>&filetype=l` — the label image itself.
   **Session-stateful:** it serves attachments of the *most recently viewed* `publicFormDisplay`
   page in that session. Always GET step 4 immediately before step 5, one COLA at a time,
   or you silently get the wrong image (verify with checksums/dimensions).

---

## Distilled spirits (4)

### 1. Old Tub — `spirits-old-tub-bourbon-front.jpg`, `spirits-old-tub-bourbon-back.jpg`

- **TTB ID:** 19113001000226 (serial 190037, approved 05/03/2019)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=19113001000226
- **Image URLs** (via form view `...action=publicFormDisplay&ttbid=19113001000226`):
  - front: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=FA110-OLD011.jpg&filetype=l
  - back: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=BK111-OLD011.jpg&filetype=l
- **Commodity type:** distilled spirits (registry class 101 Straight Bourbon Whisky)
- **Brand name (printed):** OLD TUB — fanciful name: none
- **Class/type (printed):** KENTUCKY STRAIGHT BOURBON WHISKEY; also "BOTTLED IN BOND", "SOUR MASH", "UNFILTERED"
- **Alcohol content (printed):** "50% ALC./VOL. 100 PROOF" (front top-left); "BOTTLED AT 100 PROOF" (front top-right); "100/750 mL" (back bottom)
- **Net contents (printed):** 750 mL (back, in "100/750 mL"; COLA notes net contents may be blown into container)
- **Health warning statement:** visible and legible on back label (condensed sans); printed `GOVERNMENT WARNING:(1)` with **no space after the colon**, body ALL CAPS, line-break hyphenation ("MACHIN-ERY")
- **Other:** Distilled and bottled by James B. Beam Distilling Co., Clermont, KY, DSP-KY-230
- **OCR difficulty:** medium — display serif brand, clean supporting text

### 2. Tito's Handmade Vodka — `spirits-titos-handmade-vodka-front.jpg`, `spirits-titos-handmade-vodka-back.jpg`

- **TTB ID:** 19226001000693 (serial 190044, approved 09/16/2019)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=19226001000693
- **Image URLs:**
  - front: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=Titos%20Domestic%201L%20Front%20PROOF.jpg&filetype=l
  - back: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=Titos%20Domestic%201L%20Back%20NEW%20PROOF.jpg&filetype=l
- **Commodity type:** distilled spirits (registry class 301 Vodka 80-89 proof)
- **Brand name (printed):** Tito's Handmade (registry brand "TITO'S HANDMADE"); label reads "Tito's Handmade VODKA" — fanciful name: none
- **Class/type (printed):** VODKA ("Award Winning American Vodka / Crafted in an Old Fashioned Pot Still")
- **Alcohol content (printed):** "40% ALC./VOL." (front bottom line); "80 Proof – 1L" (back)
- **Net contents (printed):** 1L (back, "80 Proof – 1L" — no space before "L" as printed; en dash, not hyphen)
- **Health warning statement:** visible and legible on back label
- **Other:** Distilled & bottled by Fifth Generation, Inc., Austin, TX (DSP-TX-57); "DISTILLED FROM CORN", "GLUTEN-FREE"
- **OCR difficulty:** mixed — script brand name ("Tito's", "Handmade"), clean sans elsewhere

### 3. Buffalo Trace Experimental Collection — `spirits-buffalo-trace-experimental-front.png`, `spirits-buffalo-trace-experimental-back.png`

- **TTB ID:** 22045001000141 (serial 220107, approved 04/04/2022)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=22045001000141
- **Image URLs:**
  - front: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=updated%20front%202.png&filetype=l
  - back: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=Experimental%20Collection%20Back%20Label.png&filetype=l
- **Commodity type:** distilled spirits (registry class 101 Straight Bourbon Whisky)
- **Brand name (printed):** BUFFALO TRACE (DISTILLERY) — "EXPERIMENTAL COLLECTION" series; fanciful name: none (registry)
- **Class/type (printed):** "Type: STRAIGHT BOURBON WHISKEY (MADE WITH PEATED MALT)"
- **Alcohol content (printed):** "Bottle Proof: 45% ALC/VOL (90 PROOF)" (front, handwriting-style font)
- **Net contents (printed):** 375ML (back, "FRANKFORT, KY 375ML")
- **Health warning statement:** visible and legible on back label (small, textured background); body ALL CAPS with line-break hyphenation ("AC-CORDING", "BEV-ERAGES")
- **Other:** Distilled, aged & bottled by Buffalo Trace Distillery Inc, Frankfort, KY (DSP-KY-113); many spec lines (still proof 130, entry proof 125, etc.) — deliberately noisy
- **OCR difficulty:** hard — handwriting-style font for all data values, textured parchment background

### 4. Maker's Mark Founders' Series — `spirits-makers-mark-founders-series-front.jpg`, `spirits-makers-mark-founders-series-back.jpg`

- **TTB ID:** 20006001000090 (serial 200001, approved 01/16/2020)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=20006001000090
- **Image URLs:**
  - front: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=FA110-AZN0313.jpg&filetype=l
  - back: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=401688604.jpg&filetype=l
  - (a strip stamp attachment `SS113-AZN0314.jpg` also exists; not downloaded)
- **Commodity type:** distilled spirits (registry class 101 Straight Bourbon Whisky)
- **Brand name (printed):** Maker's Mark — fanciful name: none (label series text "FOUNDERS' SERIES", "DISTILLERY EXCLUSIVE")
- **Class/type (printed):** KENTUCKY STRAIGHT BOURBON WHISKY — note "WHISKY" spelling, plus "Handmade"
- **Alcohol content (printed):** "1 LITER 45% ALC/VOL" (front bottom center)
- **Net contents (printed):** 1 LITER (front and back)
- **Health warning statement:** visible and legible on back label; **body is sentence case** (only "GOVERNMENT WARNING:" in caps) — the sole label here matching the canonical § 16.21 text case-for-case
- **Other:** Distilled, aged and bottled by The Maker's Mark Distillery, Inc., Star Hill Farm, Loretto, KY (DSP-KY-44); dark label, gold/cream text, portrait artwork
- **OCR difficulty:** medium-hard — low-ish contrast gold on dark gray, decorative side panels

## Wine (3)

### 5. Kendall-Jackson Vintner's Reserve Rosé — `wine-kendall-jackson-vintners-reserve-rose-front.jpg`, `wine-kendall-jackson-vintners-reserve-rose-back.jpg`

- **TTB ID:** 22075001000833 (serial 22SR07, approved 03/23/2022)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=22075001000833
- **Image URLs:**
  - front: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=V21%20KJ%20VR%20ROSE%20FC.jpg&filetype=l
  - back: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=V21%20KJ%20VR%20ROSE%20BK%20IWCA.jpg&filetype=l
- **Commodity type:** wine (registry class 80A Rosé Wine)
- **Brand name (printed):** KENDALL-JACKSON — fanciful name: VINTNER'S RESERVE
- **Class/type (printed):** ROSÉ WINE; appellation CALIFORNIA; vintage 2021
- **Alcohol content (printed):** "ALC 13.5%/VOL." (back bottom line only — nothing on front)
- **Net contents (printed):** 750ML (back bottom line)
- **Health warning statement:** visible and legible on back label; "CONTAINS SULFITES" also printed
- **Other:** Vinted & bottled by Kendall-Jackson Vineyards & Winery, Santa Rosa, CA (BW-CA-5894)
- **OCR difficulty:** easy-medium — clean serif/sans; ABV and net contents only on back

### 6. Chateau Ste. Michelle Grenache Blanc — `wine-chateau-ste-michelle-grenache-blanc-front.jpg`, `wine-chateau-ste-michelle-grenache-blanc-back.jpg`

- **TTB ID:** 21025001000948 (serial 210015, approved 01/27/2021)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=21025001000948
- **Image URLs:**
  - front: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=CSM%20VRC_Grenache%20Blanc%2020_FL.jpg&filetype=l
  - back: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=CSM%20VRC_Grenache%20Blanc%2020_BL.jpg&filetype=l
- **Commodity type:** wine (registry search row listed class 80 "Table Red Wine" but the label/form is a white — Grenache blanc; registry class codes are not always trustworthy ground truth)
- **Brand name (printed):** Chateau Ste Michelle (script, back label; front carries it only as a faint watermark) — fanciful name: none
- **Class/type (printed):** GRENACHE BLANC (varietal designation); appellation RATTLESNAKE HILLS; DINEEN FAMILY VINEYARDS; vintage 2020; "LIMITED RELEASE UP TO 279 TOTAL CASES"
- **Alcohol content (printed):** "ALC 13.5% BY VOL" (back bottom right, small)
- **Net contents (printed):** 750ml (back, "CONTAINS SULFITES 750ml")
- **Health warning statement:** visible and legible on back label
- **Other:** Produced and bottled by Chateau Ste. Michelle, Woodinville, WA (BW-WA-8)
- **OCR difficulty:** mixed — front is clean spaced caps, but brand only appears as script/watermark; good REVIEW-candidate for brand extraction from front alone

### 7. La Crema Saralee's Vineyard Chardonnay — `wine-la-crema-saralees-chardonnay-front.png`, `wine-la-crema-saralees-chardonnay-back.png`

- **TTB ID:** 22201001001022 (serial 22LC17, approved 07/21/2022)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=22201001001022
- **Image URLs:**
  - front: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=V21%20LC%20CH%20SARALEE%20FC%20637871_signed.png&filetype=l
  - back: https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=V21%20LC%20CH%20SARALEE%20BK%20637872%20V3.png&filetype=l
- **Commodity type:** wine (registry class 81 Table White Wine)
- **Brand name (printed):** LA CREMA — fanciful name: SARALEE'S VINEYARD
- **Class/type (printed):** CHARDONNAY (varietal designation); appellation RUSSIAN RIVER VALLEY (back adds SONOMA COUNTY); vintage 2021
- **Alcohol content (printed):** "13.5% ALC/VOL" (back, single condensed line)
- **Net contents (printed):** 750ML (back, same line: "...WINDSOR, CALIFORNIA - 750ML - 13.5% ALC/VOL - ...")
- **Health warning statement:** visible on back label; legible but **low contrast** (light gray on gray)
- **Other:** Vinted and bottled by La Crema, Windsor, California; "CONTAINS SULFITES"
- **OCR difficulty:** hard — low-contrast gray-on-gray throughout; good stress test for the local OCR tier

## Malt beverage (3)

### 8. Sierra Nevada Oktoberfest — `malt-sierra-nevada-oktoberfest-can.jpg`

- **TTB ID:** 21062001000372 (serial 210010, approved 03/08/2021)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=21062001000372
- **Image URL:** https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=Oktoberfest%20can.jpg&filetype=l (single full can-wrap image)
- **Commodity type:** malt beverage (registry class 901 Beer)
- **Brand name (printed):** SIERRA NEVADA — fanciful name: OKTOBERFEST
- **Class/type (printed):** AMBER MÄRZEN (front); "MARZEN-STYLE AMBER LAGER" (side panel)
- **Alcohol content (printed):** "5.5% ABV" (front); "ALC. 5.5% BY VOL." (side panel)
- **Net contents (printed):** 12 FL. OZ. (vertical, center of wrap)
- **Health warning statement:** visible on right side panel, rotated 90°, legible
- **Other:** Sierra Nevada Brewing Co., Chico, CA & Mills River, NC
- **OCR difficulty:** medium-hard — ornate display type for brand/fanciful, rotated warning text, diamond-pattern background

### 9. Samuel Adams Boston Lager — `malt-samuel-adams-boston-lager-can.jpg`

- **TTB ID:** 22082001000877 (serial 22014B, approved 03/25/2022)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=22082001000877
- **Image URL:** https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=PKG_SAM_Remastered_12oz_030922_TTB.jpg&filetype=l (single full can-wrap image)
- **Commodity type:** malt beverage (registry class 901 Beer)
- **Brand name (printed):** SAMUEL ADAMS — fanciful name: BOSTON LAGER
- **Class/type (printed):** LAGER ("LAGER | 5.0% ALC./VOL. | 30 IBUs" line; "Remastered" series text)
- **Alcohol content (printed):** "5.0% ALC./VOL."
- **Net contents (printed):** 12 FL. OZ.
- **Health warning statement:** visible, rotated 90° in small type on right edge of wrap; legible at full resolution (2505x1385)
- **Other:** Brewed by The Boston Beer Co., Boston, MA., Breinigsville, PA., and Cincinnati, OH
- **OCR difficulty:** medium — clean type but small ABV/contents line and tiny rotated warning

### 10. Guinness Draught Stout (Notre Dame 2022 edition) — `malt-guinness-draught-stout-can.jpg`

- **TTB ID:** 22136001000844 (serial 22R059, approved 05/17/2022)
- **Detail page:** https://www.ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid=22136001000844
- **Image URL:** https://www.ttbonline.gov/colasonline/publicViewAttachment.do?filename=Guinness%20ND.jpg&filetype=l (single full can-wrap image)
- **Commodity type:** malt beverage — imported (registry origin Ireland, class 954 Stout)
- **Brand name (printed):** GUINNESS — fanciful name: none (label series text "2022 EDITION", "GO IRISH", Notre Dame co-brand)
- **Class/type (printed):** DRAUGHT STOUT ("ST JAMES'S GATE DUBLIN, IRELAND")
- **Alcohol content (printed):** "4.1% alc./vol."
- **Net contents (printed):** 14.9 FL. OZ.
- **Health warning statement:** visible on left panel, legible; also Serving Facts panel
- **Other:** Brewed in Ireland by Guinness & Co.; imported by Diageo Beer Company USA, New York, NY
- **OCR difficulty:** medium — gold-on-black, mixed orientations ("GO IRISH" vertical), import-specific fields
