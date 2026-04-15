const assert = require("assert");
const {
  normalizePlate,
  validatePlate,
  isGreetingOrReset,
  extractInboundText,
  extractInteractiveId,
  detectIntent,
  computeReprogPrice,
  computeE85Price,
  computeFapPrice,
  computeAdbluePrice,
  validateEmail,
  STAGE1_FIXED_PRICE_CENTS,
} = require("../helpers");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
  }
}

// ====== normalizePlate ======
console.log("\n📋 normalizePlate");

test("formats valid SIV plate with spaces", () => {
  assert.strictEqual(normalizePlate("ab 123 cd"), "AB-123-CD");
});

test("formats valid SIV plate with hyphens", () => {
  assert.strictEqual(normalizePlate("AB-123-CD"), "AB-123-CD");
});

test("formats valid SIV plate no separators", () => {
  assert.strictEqual(normalizePlate("ab123cd"), "AB-123-CD");
});

test("returns cleaned string for invalid plate", () => {
  assert.strictEqual(normalizePlate("1234ABC"), "1234ABC");
});

test("handles empty/null input", () => {
  assert.strictEqual(normalizePlate(""), "");
  assert.strictEqual(normalizePlate(null), "");
});

// ====== validatePlate ======
console.log("\n📋 validatePlate");

test("valid plate returns valid: true", () => {
  const r = validatePlate("AB 123 CD");
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.plate, "AB-123-CD");
});

test("invalid plate returns valid: false", () => {
  const r = validatePlate("hello");
  assert.strictEqual(r.valid, false);
});

test("partial plate is invalid", () => {
  const r = validatePlate("AB-12-CD");
  assert.strictEqual(r.valid, false);
});

// ====== isGreetingOrReset ======
console.log("\n📋 isGreetingOrReset");

test("detects bonjour", () => assert.strictEqual(isGreetingOrReset("Bonjour"), true));
test("detects salut", () => assert.strictEqual(isGreetingOrReset("salut"), true));
test("detects menu", () => assert.strictEqual(isGreetingOrReset("menu"), true));
test("detects 0", () => assert.strictEqual(isGreetingOrReset("0"), true));
test("detects annuler", () => assert.strictEqual(isGreetingOrReset("annuler"), true));
test("ignores random text", () => assert.strictEqual(isGreetingOrReset("je veux un devis"), false));
test("handles null", () => assert.strictEqual(isGreetingOrReset(null), false));

// ====== extractInboundText ======
console.log("\n📋 extractInboundText");

test("extracts text body", () => {
  assert.strictEqual(extractInboundText({ type: "text", text: { body: "hello" } }), "hello");
});

test("extracts button text", () => {
  assert.strictEqual(extractInboundText({ type: "button", button: { text: "Oui" } }), "Oui");
});

test("extracts interactive button reply", () => {
  const msg = { type: "interactive", interactive: { button_reply: { title: "OK", id: "ok_1" } } };
  assert.strictEqual(extractInboundText(msg), "OK");
});

test("extracts interactive list reply", () => {
  const msg = { type: "interactive", interactive: { list_reply: { title: "Reprog", id: "menu_1" } } };
  assert.strictEqual(extractInboundText(msg), "Reprog");
});

test("returns [unknown] for missing type", () => {
  assert.strictEqual(extractInboundText({}), "[unknown]");
});

// ====== extractInteractiveId ======
console.log("\n📋 extractInteractiveId");

test("returns button_reply id", () => {
  const msg = { type: "interactive", interactive: { button_reply: { id: "btn_1", title: "X" } } };
  assert.strictEqual(extractInteractiveId(msg), "btn_1");
});

test("returns null for non-interactive", () => {
  assert.strictEqual(extractInteractiveId({ type: "text" }), null);
});

// ====== detectIntent ======
console.log("\n📋 detectIntent");

test("detects menu number 1 as REPROG", () => assert.strictEqual(detectIntent("1"), "REPROG"));
test("detects menu number 2 as E85", () => assert.strictEqual(detectIntent("2"), "E85"));
test("detects menu number 3 as FAP", () => assert.strictEqual(detectIntent("3"), "FAP"));
test("detects menu number 8 as SAV", () => assert.strictEqual(detectIntent("8"), "SAV"));
test("detects keyword reprog", () => assert.strictEqual(detectIntent("reprogrammation moteur"), "REPROG"));
test("detects keyword e85", () => assert.strictEqual(detectIntent("conversion e85"), "E85"));
test("detects keyword fap", () => assert.strictEqual(detectIntent("suppression fap"), "FAP"));
test("detects keyword adblue", () => assert.strictEqual(detectIntent("problème adblue"), "ADBLUE"));
test("returns null for question", () => assert.strictEqual(detectIntent("combien coûte une reprog ?"), null));
test("returns null for unrecognized text", () => assert.strictEqual(detectIntent("bonjour"), null));

// ====== computeReprogPrice ======
console.log("\n📋 computeReprogPrice");

test("returns fixed price for <400hp <2018", () => {
  assert.strictEqual(computeReprogPrice({ power_hp: 150, year: 2015 }), STAGE1_FIXED_PRICE_CENTS);
});

test("returns null for >=400hp", () => {
  assert.strictEqual(computeReprogPrice({ power_hp: 450, year: 2015 }), null);
});

test("returns null for >=2018", () => {
  assert.strictEqual(computeReprogPrice({ power_hp: 150, year: 2020 }), null);
});

test("returns null for missing data", () => {
  assert.strictEqual(computeReprogPrice({}), null);
});

// ====== computeE85Price ======
console.log("\n📋 computeE85Price");

test("returns 490€ for <2020", () => {
  assert.strictEqual(computeE85Price({ year: 2018 }), 49000);
});

test("returns null for >=2020", () => {
  assert.strictEqual(computeE85Price({ year: 2022 }), null);
});

// ====== computeFapPrice ======
console.log("\n📋 computeFapPrice");

test("returns 260€ for <2019", () => {
  assert.strictEqual(computeFapPrice({ year: 2017 }), 26000);
});

test("returns 300€ for >=2019", () => {
  assert.strictEqual(computeFapPrice({ year: 2021 }), 30000);
});

// ====== computeAdbluePrice ======
console.log("\n📋 computeAdbluePrice");

test("returns 260€ for BlueHDi", () => {
  assert.strictEqual(computeAdbluePrice({ engine: "BlueHDi 130" }), 26000);
});

test("returns 300€ for non-BlueHDi", () => {
  assert.strictEqual(computeAdbluePrice({ engine: "TDI 150" }), 30000);
});

// ====== validateEmail ======
console.log("\n📋 validateEmail");

test("accepts valid email", () => {
  assert.strictEqual(validateEmail("test@example.com"), "test@example.com");
});

test("rejects invalid email", () => {
  assert.strictEqual(validateEmail("not-an-email"), null);
});

test("trims and lowercases", () => {
  assert.strictEqual(validateEmail("  Test@Example.COM  "), "test@example.com");
});

// ====== Summary ======
console.log(`\n=============================`);
console.log(`✅ Passed: ${passed}  ❌ Failed: ${failed}`);
console.log(`=============================\n`);

if (failed > 0) process.exit(1);
