/**
 * Tests pour les calculs de prix dans lib/vehicle-service.js
 *
 * Couvre :
 *   - computeReprogPrice
 *   - computeE85Price
 *   - computeAdbluePrice
 *   - computeEgrPrice
 *   - computeFapPrice
 *   - _isDieselVehicle / _isEssenceVehicle / _hasAdBlueSystem
 *
 * Régression critique : une erreur de prix = un client facturé au mauvais montant.
 */

const {
  computeReprogPrice,
  computeE85Price,
  computeAdbluePrice,
  computeEgrPrice,
  computeFapPrice,
  _isDieselVehicle,
  _isEssenceVehicle,
  _hasAdBlueSystem,
  STAGE1_FIXED_PRICE_CENTS,
} = require("../lib/vehicle-service");

let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label} — attendu ${expected}, reçu ${actual}`);
  }
}

console.log("\n💶 Testing vehicle-service pricing\n");

// ====== computeReprogPrice ======
console.log("🧪 computeReprogPrice");
check("essence < 400hp < 2018 → tarif fixe", computeReprogPrice({ power_hp: 150, year: 2015, fuel: "essence" }), STAGE1_FIXED_PRICE_CENTS);
check("diesel < 400hp < 2018 → tarif fixe", computeReprogPrice({ power_hp: 110, year: 2010, fuel: "diesel" }), STAGE1_FIXED_PRICE_CENTS);
check("année ≥ 2018 → null (devis manuel)", computeReprogPrice({ power_hp: 150, year: 2018 }), null);
check("année 2022 → null", computeReprogPrice({ power_hp: 200, year: 2022 }), null);
check("≥ 400hp → null", computeReprogPrice({ power_hp: 400, year: 2015 }), null);
check("> 400hp → null", computeReprogPrice({ power_hp: 550, year: 2010 }), null);
check("hp manquant → null", computeReprogPrice({ year: 2015 }), null);
check("hp = 0 → null", computeReprogPrice({ power_hp: 0, year: 2015 }), null);
check("année manquante → null", computeReprogPrice({ power_hp: 150 }), null);
check("véhicule null → null", computeReprogPrice(null), null);
check("véhicule vide → null", computeReprogPrice({}), null);

// ====== computeE85Price ======
console.log("\n🧪 computeE85Price");
check("année < 2020 → 49 000 c", computeE85Price({ year: 2018 }), 49000);
check("année 2019 → 49 000 c", computeE85Price({ year: 2019 }), 49000);
check("année 2020 → null (devis manuel)", computeE85Price({ year: 2020 }), null);
check("année 2022 → null", computeE85Price({ year: 2022 }), null);
check("année absente → null", computeE85Price({}), null);
check("véhicule null → null", computeE85Price(null), null);

// ====== computeAdbluePrice ======
console.log("\n🧪 computeAdbluePrice");
check("BlueHDi (engine) → 26 000 c", computeAdbluePrice({ engine: "1.6 BlueHDi 120" }), 26000);
check("BlueHDi (model) → 26 000 c", computeAdbluePrice({ model: "308 BlueHDi" }), 26000);
check("blue-hdi avec tiret → 26 000 c", computeAdbluePrice({ trim: "blue-hdi 130" }), 26000);
check("diesel standard non BlueHDi → 30 000 c", computeAdbluePrice({ fuel: "diesel" }), 30000);
check("essence → 30 000 c (toujours un prix)", computeAdbluePrice({ fuel: "essence" }), 30000);
check("véhicule vide → 30 000 c", computeAdbluePrice({}), 30000);

// ====== computeEgrPrice ======
console.log("\n🧪 computeEgrPrice");
check("fuel=diesel → 19 000 c", computeEgrPrice({ fuel: "diesel" }), 19000);
check("fuel=GAZOLE → 19 000 c", computeEgrPrice({ fuel: "GAZOLE" }), 19000);
check("fuel HDI/TDI tag → 19 000 c", computeEgrPrice({ fuel: "HDI" }), 19000);
check("fuel=essence → null (non applicable)", computeEgrPrice({ fuel: "essence" }), null);
check("fuel absent → null", computeEgrPrice({}), null);
check("véhicule null → null", computeEgrPrice(null), null);

// ====== computeFapPrice ======
console.log("\n🧪 computeFapPrice");
check("année < 2019 → 26 000 c", computeFapPrice({ year: 2015 }), 26000);
check("année 2018 → 26 000 c", computeFapPrice({ year: 2018 }), 26000);
check("année 2019 → 30 000 c", computeFapPrice({ year: 2019 }), 30000);
check("année 2022 → 30 000 c", computeFapPrice({ year: 2022 }), 30000);
check("année absente → 30 000 c (défaut)", computeFapPrice({}), 30000);

// ====== _isDieselVehicle ======
console.log("\n🧪 _isDieselVehicle");
check("fuel=diesel → true", _isDieselVehicle({ fuel: "diesel" }), true);
check("fuel=HDI → true", _isDieselVehicle({ fuel: "HDI" }), true);
check("fuel=TDI → true", _isDieselVehicle({ fuel: "TDI" }), true);
check("fuel=GO → true", _isDieselVehicle({ fuel: "GO" }), true);
check("fuel=essence → false", _isDieselVehicle({ fuel: "essence" }), false);
check("fuel=SP95 → false", _isDieselVehicle({ fuel: "SP95" }), false);
check("véhicule vide → false", _isDieselVehicle({}), false);

// ====== _isEssenceVehicle ======
console.log("\n🧪 _isEssenceVehicle");
check("fuel=essence → true", _isEssenceVehicle({ fuel: "essence" }), true);
check("fuel=SP98 → true", _isEssenceVehicle({ fuel: "SP98" }), true);
check("fuel=hybride → true", _isEssenceVehicle({ fuel: "hybride" }), true);
check("fuel=GPL → true", _isEssenceVehicle({ fuel: "GPL" }), true);
check("fuel=diesel → false", _isEssenceVehicle({ fuel: "diesel" }), false);
check("véhicule vide → false", _isEssenceVehicle({}), false);

// ====== _hasAdBlueSystem ======
console.log("\n🧪 _hasAdBlueSystem");
check("BlueHDi → true", _hasAdBlueSystem({ engine: "BlueHDi 130" }), true);
check("AdBlue mentionné → true", _hasAdBlueSystem({ trim: "AdBlue" }), true);
check("SCR mentionné → true", _hasAdBlueSystem({ engine: "2.0 TDI SCR" }), true);
check("diesel Euro6 (year≥2015) → true", _hasAdBlueSystem({ fuel: "diesel", year: 2017 }), true);
check("diesel ancien (year<2015) → false", _hasAdBlueSystem({ fuel: "diesel", year: 2010 }), false);
check("essence → false", _hasAdBlueSystem({ fuel: "essence", year: 2020 }), false);

// ====== Résumé ======
console.log("");
if (failed === 0) {
  console.log("✅ Tous les tests de pricing OK");
  process.exit(0);
} else {
  console.error(`❌ ${failed} test(s) en échec`);
  process.exit(1);
}
