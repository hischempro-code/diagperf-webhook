const { formatStageLabel } = require("./vehicle-service");

let _log, _fetchFn;
let _sendWhatsAppImage, _sendWhatsAppList;

const DIAGPERF_LOCATION = {
  latitude: 48.9583,
  longitude: 2.8789,
  name: "DiagPerf – Reprogrammation & Diagnostic",
  address: "38 Rue Jean Pierre Plicque, 77124 Villenoy",
};

function initMediaBuilders({ log, fetchFn, sendWhatsAppImage, sendWhatsAppList }) {
  _log = log;
  _fetchFn = fetchFn;
  _sendWhatsAppImage = sendWhatsAppImage;
  _sendWhatsAppList = sendWhatsAppList;
}

// ====== Geocoding + estimation trajet ======
async function geocodeAddress(query) {
  try {
    const q = String(query || "").trim();
    if (!q || q.length < 2) return null;
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1&type=municipality`;
    const res = await _fetchFn(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json();
    const feat = json?.features?.[0];
    if (!feat) return null;
    const [lng, lat] = feat.geometry.coordinates;
    const label = feat.properties?.label || feat.properties?.city || q;
    return { lat, lng, label };
  } catch (err) {
    _log.debug("geocodeAddress failed", { query, error: String(err?.message || err) });
    return null;
  }
}

async function estimateTravelTime(fromLat, fromLng) {
  try {
    const toLat = DIAGPERF_LOCATION.latitude;
    const toLng = DIAGPERF_LOCATION.longitude;
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
    const res = await _fetchFn(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json();
    const route = json?.routes?.[0];
    if (!route) return null;
    const durationMin = Math.round(route.duration / 60);
    const distanceKm = Math.round(route.distance / 1000);
    return { durationMin, distanceKm };
  } catch (err) {
    _log.debug("estimateTravelTime failed", { fromLat, fromLng, error: String(err?.message || err) });
    return null;
  }
}

async function buildTravelEstimateMessage(cityQuery) {
  const geo = await geocodeAddress(cityQuery);
  if (!geo) return null;
  const travel = await estimateTravelTime(geo.lat, geo.lng);
  if (!travel) return null;
  return (
    `📍 Vous êtes à environ *${travel.durationMin} min* (${travel.distanceKm} km) de DiagPerf !\n\n` +
    `🏁 Départ : ${geo.label}\n` +
    `🏠 Arrivée : ${DIAGPERF_LOCATION.address}\n\n` +
    `🚗 Parking gratuit sur place. Nous sommes à 5 min à pied de la gare de Villenoy.`
  );
}

// ====== Vehicle image URL builder ======
const MAKE_WIKI_MAP = {
  citroen:"Citroën", citroën:"Citroën",
  peugeot:"Peugeot", renault:"Renault",
  volkswagen:"Volkswagen", mercedes:"Mercedes-Benz", "mercedes-benz":"Mercedes-Benz",
  bmw:"BMW", audi:"Audi", ford:"Ford", opel:"Opel", fiat:"Fiat",
  toyota:"Toyota", honda:"Honda", nissan:"Nissan", hyundai:"Hyundai",
  kia:"Kia", seat:"SEAT", skoda:"Škoda", dacia:"Dacia",
  volvo:"Volvo", mini:"Mini", porsche:"Porsche", tesla:"Tesla",
  alfa:"Alfa Romeo", "alfa romeo":"Alfa Romeo", suzuki:"Suzuki",
  mazda:"Mazda", mitsubishi:"Mitsubishi", subaru:"Subaru",
  chevrolet:"Chevrolet", jeep:"Jeep", land:"Land Rover", "land rover":"Land Rover",
  jaguar:"Jaguar", lexus:"Lexus", infiniti:"Infiniti", cupra:"Cupra",
  ds:"DS", smart:"Smart",
};

async function getVehicleImageUrl(vehicle) {
  if (!vehicle?.make) return null;
  const makeRaw = String(vehicle.make).trim();
  const modelRaw = String(vehicle.model || "").trim().split(" ")[0];
  if (!modelRaw) return null;
  const year = vehicle.year ? String(vehicle.year) : "";

  const wikiMake = MAKE_WIKI_MAP[makeRaw.toLowerCase()] || makeRaw.charAt(0).toUpperCase() + makeRaw.slice(1).toLowerCase();

  try {
    const searchQuery = `${wikiMake} ${modelRaw}${year ? ` ${year}` : ""} car`;
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQuery)}&srlimit=3&format=json`;
    const searchResp = await _fetchFn(searchUrl);
    const searchJson = await searchResp.json();
    const searchResults = searchJson?.query?.search || [];

    const modelLower = modelRaw.toLowerCase();
    const bestArticle = searchResults.find(r => r.title.toLowerCase().includes(modelLower)) || searchResults[0];
    if (!bestArticle) throw new Error("No Wikipedia article found");

    const articleTitle = bestArticle.title;
    _log.debug("Wikipedia article found", { search: searchQuery, article: articleTitle });

    const imgsUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(articleTitle)}&prop=images&imlimit=50&format=json`;
    const imgsResp = await _fetchFn(imgsUrl);
    const imgsJson = await imgsResp.json();
    const pages = Object.values(imgsJson?.query?.pages || {});
    const allImages = (pages[0]?.images || [])
      .map(i => i.title)
      .filter(t => /\.(jpg|jpeg|png)$/i.test(t) && !/flag|icon|logo|commons|wiki|map/i.test(t));

    let bestFile = null;

    if (year && allImages.length) {
      bestFile = allImages.find(t => t.includes(year) && /front/i.test(t));

      if (!bestFile) {
        const yearNum = parseInt(year);
        for (let delta = 0; delta <= 3; delta++) {
          for (const y of [String(yearNum + delta), String(yearNum - delta)]) {
            const m = allImages.find(t => t.includes(y) && /front/i.test(t));
            if (m) { bestFile = m; break; }
          }
          if (bestFile) break;
        }
      }

      if (!bestFile) {
        const yearNum = parseInt(year);
        for (let delta = 0; delta <= 3; delta++) {
          for (const y of [String(yearNum + delta), String(yearNum - delta)]) {
            const m = allImages.find(t => t.includes(y) && !/rear|interior|engine|badge|back|dashboard/i.test(t));
            if (m) { bestFile = m; break; }
          }
          if (bestFile) break;
        }
      }
    }

    if (bestFile) {
      const fileUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(bestFile)}&prop=imageinfo&iiprop=url&iiurlwidth=800&format=json`;
      const fileResp = await _fetchFn(fileUrl);
      const fileJson = await fileResp.json();
      const filePages = Object.values(fileJson?.query?.pages || {});
      const thumbUrl = filePages[0]?.imageinfo?.[0]?.thumburl;
      if (thumbUrl) {
        _log.debug("Wikipedia year-matched image", { article: articleTitle, year, file: bestFile });
        return thumbUrl;
      }
    }

    const piUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(articleTitle)}&prop=pageimages&piprop=thumbnail&pithumbsize=800&format=json`;
    const piResp = await _fetchFn(piUrl);
    const piJson = await piResp.json();
    const piPages = Object.values(piJson?.query?.pages || {});
    const piThumb = piPages[0]?.thumbnail?.source;
    if (piThumb) {
      _log.debug("Wikipedia pageimage fallback", { article: articleTitle });
      return piThumb;
    }
  } catch (wikiErr) {
    _log.debug("Wikipedia image lookup failed", { error: String(wikiErr?.message || wikiErr) });
  }

  const make = encodeURIComponent(makeRaw.toLowerCase());
  const model = encodeURIComponent(modelRaw.toLowerCase());
  let url = `https://cdn.imagin.studio/getimage?customer=img&make=${make}&modelFamily=${model}`;
  if (year) url += `&modelYear=${year}`;
  url += `&angle=01&zoomType=fullscreen&fileType=png&width=800`;
  return url;
}

// ====== Dyno chart builder ======
function generateDynoCurve(peakValue, peakRpmRatio, rpmPoints) {
  return rpmPoints.map(rpm => {
    const x = rpm / rpmPoints[rpmPoints.length - 1];
    const k = peakRpmRatio;
    const curve = peakValue * Math.pow(x / k, 1.5) * Math.exp(1.5 * (1 - x / k));
    return Math.round(curve);
  });
}

function buildDynoChartUrl(peakPowerOrig, peakPowerMod, peakTorqueOrig, peakTorqueMod, vehicleName, subtitle) {
  const rpmPoints = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000];
  const rpmLabels = rpmPoints.map(r => String(r));
  const pwrOrig = generateDynoCurve(peakPowerOrig, 0.78, rpmPoints);
  const pwrMod = generateDynoCurve(peakPowerMod, 0.78, rpmPoints);
  const trqOrig = generateDynoCurve(peakTorqueOrig, 0.5, rpmPoints);
  const trqMod = generateDynoCurve(peakTorqueMod, 0.5, rpmPoints);

  const chart = {
    type: "line",
    data: {
      labels: rpmLabels,
      datasets: [
        { label: `Puissance origine (${peakPowerOrig} ch)`, data: pwrOrig, borderColor: "rgba(120,120,120,0.8)", borderWidth: 2, borderDash: [6, 3], fill: false, lineTension: 0.4, pointRadius: 0, yAxisID: "y-power" },
        { label: `Puissance modifiée (${peakPowerMod} ch)`, data: pwrMod, borderColor: "rgb(220,38,38)", borderWidth: 3, fill: false, lineTension: 0.4, pointRadius: 0, yAxisID: "y-power" },
        { label: `Couple origine (${peakTorqueOrig} Nm)`, data: trqOrig, borderColor: "rgba(100,100,100,0.7)", borderWidth: 2, borderDash: [6, 3], fill: false, lineTension: 0.4, pointRadius: 0, yAxisID: "y-torque" },
        { label: `Couple modifié (${peakTorqueMod} Nm)`, data: trqMod, borderColor: "rgb(37,99,235)", borderWidth: 3, fill: false, lineTension: 0.4, pointRadius: 0, yAxisID: "y-torque" },
      ],
    },
    options: {
      title: { display: true, text: [vehicleName, subtitle], fontSize: 15, fontStyle: "bold" },
      legend: { position: "bottom", labels: { usePointStyle: true, padding: 12 } },
      scales: {
        xAxes: [{ scaleLabel: { display: true, labelString: "Régime (tr/min)", fontStyle: "bold" } }],
        yAxes: [
          { id: "y-power", type: "linear", position: "left", scaleLabel: { display: true, labelString: "Puissance (ch)", fontColor: "rgb(220,38,38)", fontStyle: "bold" }, ticks: { beginAtZero: true } },
          { id: "y-torque", type: "linear", position: "right", scaleLabel: { display: true, labelString: "Couple (Nm)", fontColor: "rgb(37,99,235)", fontStyle: "bold" }, ticks: { beginAtZero: true }, gridLines: { drawOnChartArea: false } },
        ],
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chart));
  return `https://quickchart.io/chart?c=${encoded}&w=700&h=420&bkg=white&f=png`;
}

function buildGainsChartUrl(stages, vehicleName) {
  if (!stages || stages.length === 0) return null;
  const s = stages[0];
  const bestStage = stages.reduce((best, cur) => ((cur.puissance_apres || 0) > (best.puissance_apres || 0) ? cur : best), stages[0]);
  const sub = stages.map(st => `${formatStageLabel(st.stage)}: ${st.puissance_apres}ch / ${st.couple_apres}Nm`).join("  |  ");
  return buildDynoChartUrl(s.puissance_origine || 0, bestStage.puissance_apres || 0, s.couple_origine || 0, bestStage.couple_apres || 0, vehicleName, sub);
}

function buildSingleStageChartUrl(stage, vehicleName) {
  if (!stage) return null;
  const stageLabel = formatStageLabel(stage.stage);
  const sub = `${stageLabel} — +${stage.gain_puissance || "?"}ch / +${stage.gain_couple || "?"}Nm`;
  return buildDynoChartUrl(stage.puissance_origine || 0, stage.puissance_apres || 0, stage.couple_origine || 0, stage.couple_apres || 0, vehicleName, sub);
}

function buildVehicleCardUrl({ vehicle, stage, stageLabel, priceTtc }) {
  if (!vehicle?.make) return null;
  const vName = `${vehicle.make} ${vehicle.model || ""}`.trim();
  const yearTxt = vehicle.year ? `${vehicle.year}` : "";
  const fuelTxt = vehicle.fuel ? vehicle.fuel.toUpperCase() : "";
  const ccTxt = vehicle.engine_cc ? `${vehicle.engine_cc}cc` : "";
  const hpTxt = vehicle.power_hp ? `${vehicle.power_hp}ch` : "";
  const engineTxt = [fuelTxt, ccTxt, hpTxt].filter(Boolean).join(" • ");
  const plateTxt = vehicle.plate || "";

  const pwrOrig = stage?.puissance_origine || vehicle.power_hp || 0;
  const pwrAfter = stage?.puissance_apres || 0;
  const trqOrig = stage?.couple_origine || 0;
  const trqAfter = stage?.couple_apres || 0;
  const gainPwr = stage?.gain_puissance || 0;
  const gainTrq = stage?.gain_couple || 0;
  const isE85 = /e85/i.test(stage?.stage || "");

  const chart = {
    type: "bar",
    data: {
      labels: isE85 ? ["Économie carburant"] : ["Puissance (ch)", "Couple (Nm)"],
      datasets: isE85 ? [
        { label: "Jusqu'à -40% sur le carburant", data: [40], backgroundColor: "#22c55e", barThickness: 36 },
      ] : [
        { label: "Origine", data: [pwrOrig, trqOrig], backgroundColor: "rgba(120,120,120,0.6)", barThickness: 28 },
        { label: "Après reprog", data: [pwrAfter, trqAfter], backgroundColor: ["rgba(220,38,38,0.9)", "rgba(37,99,235,0.9)"], barThickness: 28 },
      ],
    },
    options: {
      indexAxis: "y",
      layout: { padding: { top: 10, bottom: 10, left: 10, right: 10 } },
      plugins: {
        title: { display: true, text: [`🏁 ${vName}${yearTxt ? ` (${yearTxt})` : ""}`, engineTxt, plateTxt ? `Plaque : ${plateTxt}` : "", "", stageLabel ? `Prestation : ${stageLabel}` : "", ...(isE85 ? ["Conversion Bioéthanol E85"] : [gainPwr ? `⚡ +${gainPwr}ch  |  +${gainTrq}Nm` : ""]), priceTtc ? `💰 ${priceTtc}` : ""].filter(Boolean), font: { size: 14, weight: "bold" }, color: "#1a1a2e", padding: { bottom: 16 } },
        subtitle: { display: true, text: "DIAGPERF — Reprogrammation & Diagnostic", font: { size: 11, weight: "bold" }, color: "#3b82f6", padding: { bottom: 8 } },
        legend: { position: "bottom", labels: { usePointStyle: true, padding: 10, font: { size: 11 } } },
        datalabels: { display: true, anchor: "end", align: "right", font: { weight: "bold", size: 13 }, color: "#1a1a2e", formatter: (v) => v + (isE85 ? "%" : "") },
      },
      scales: {
        x: { display: true, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { display: false }, ticks: { font: { size: 13, weight: "bold" }, color: "#1a1a2e" } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chart));
  return `https://quickchart.io/chart?c=${encoded}&w=600&h=400&bkg=%23f8f9fa&v=4&f=png`;
}

function buildPrestationCardUrl({ vehicle, intent, prestationLabel, priceTtc, extra = {} }) {
  if (!vehicle?.make) return null;
  const vName = `${vehicle.make} ${vehicle.model || ""}`.trim();
  const yearTxt = vehicle.year ? `${vehicle.year}` : "";
  const fuelTxt = vehicle.fuel ? vehicle.fuel.toUpperCase() : "";
  const ccTxt = vehicle.engine_cc ? `${vehicle.engine_cc}cc` : "";
  const hpTxt = vehicle.power_hp ? `${vehicle.power_hp}ch` : "";
  const engineTxt = [fuelTxt, ccTxt, hpTxt].filter(Boolean).join(" • ");
  const plateTxt = vehicle.plate || "";

  let labels = [], datasets = [], subtitleLines = [], unit = "";

  if (intent === "E85") {
    labels = ["Économie carburant", "Réduction CO₂"];
    datasets = [{ label: "Jusqu'à (%)", data: [40, 70], backgroundColor: ["#22c55e", "#16a34a"], barThickness: 32 }];
    subtitleLines = ["🌿 Conversion Bioéthanol E85", "Compatible essence uniquement"];
    unit = "%";
  } else if (intent === "FAP") {
    labels = ["Risque colmatage", "Pertes de puissance", "Consommation"];
    datasets = [{ label: "Réduction (%)", data: [100, 15, 5], backgroundColor: ["#3b82f6", "#2563eb", "#1d4ed8"], barThickness: 32 }];
    subtitleLines = ["🔧 Suppression FAP", "Fin des problèmes de colmatage"];
    unit = "%";
  } else if (intent === "ADBLUE") {
    labels = ["Pannes SCR", "Entretien AdBlue", "Voyants moteur"];
    datasets = [{ label: "Réduction (%)", data: [100, 100, 100], backgroundColor: ["#8b5cf6", "#7c3aed", "#6d28d9"], barThickness: 32 }];
    subtitleLines = ["💧 Suppression AdBlue", "Fin des coûts d'entretien SCR"];
    unit = "%";
  } else if (intent === "DIAG") {
    labels = ["Défauts lus", "Codes effacés", "Précision diag"];
    datasets = [{ label: "Couverture (%)", data: [100, 100, 100], backgroundColor: ["#f59e0b", "#d97706", "#b45309"], barThickness: 32 }];
    subtitleLines = ["🔍 Diagnostic électronique complet"];
    unit = "%";
  } else if (intent === "EGR") {
    labels = ["Encrassement moteur", "Consommation", "Fiabilité"];
    datasets = [{ label: "Amélioration (%)", data: [100, 8, 80], backgroundColor: ["#10b981", "#059669", "#047857"], barThickness: 32 }];
    subtitleLines = ["🔩 Suppression EGR (Diesel uniquement)", "Fin de l'encrassement moteur"];
    unit = "%";
  } else {
    return null;
  }

  const chart = {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis: "y",
      layout: { padding: { top: 10, bottom: 10, left: 10, right: 10 } },
      plugins: {
        title: { display: true, text: [`🏁 ${vName}${yearTxt ? ` (${yearTxt})` : ""}`, engineTxt, plateTxt ? `Plaque : ${plateTxt}` : "", "", prestationLabel ? `Prestation : ${prestationLabel}` : "", ...subtitleLines, priceTtc ? `💰 ${priceTtc}` : ""].filter(Boolean), font: { size: 14, weight: "bold" }, color: "#1a1a2e", padding: { bottom: 16 } },
        subtitle: { display: true, text: "DIAGPERF — Reprogrammation & Diagnostic", font: { size: 11, weight: "bold" }, color: "#3b82f6", padding: { bottom: 8 } },
        legend: { display: false },
        datalabels: { display: true, anchor: "end", align: "right", font: { weight: "bold", size: 13 }, color: "#1a1a2e", formatter: (v) => v + unit },
      },
      scales: {
        x: { display: true, grid: { display: false }, ticks: { font: { size: 11 } }, max: 100 },
        y: { grid: { display: false }, ticks: { font: { size: 12, weight: "bold" }, color: "#1a1a2e" } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chart));
  return `https://quickchart.io/chart?c=${encoded}&w=600&h=400&bkg=%23f8f9fa&v=4&f=png`;
}

// ====== Menu list sender ======
async function sendMenuList(to, { showLogo = false } = {}) {
  if (showLogo) {
    const logoUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/assets/logo.png`;
    try {
      await _sendWhatsAppImage(to, logoUrl, "");
    } catch (imgErr) {
      _log.debug("Logo send failed (non-blocking)", { error: String(imgErr?.message || imgErr) });
    }
  }
  return _sendWhatsAppList(
    to,
    `Bonjour 👋 Bienvenue chez DiagPerf 🚗💨\n\nPour obtenir un devis personnalisé, veuillez choisir la prestation souhaitée :`,
    "Nos prestations",
    [{
      title: "Nos prestations",
      rows: [
        { id: "menu_1", title: "Reprog moteur", description: "Optimisation de la puissance et du couple" },
        { id: "menu_2", title: "Conversion E85", description: "Passage au biothanol (essence uniquement)" },
        { id: "menu_3", title: "Suppression FAP", description: "Filtre à particules" },
        { id: "menu_4", title: "Suppression EGR", description: "Vanne EGR" },
        { id: "menu_5", title: "Suppression ADBlue", description: "Système AdBlue" },
        { id: "menu_6", title: "Diagnostic complet", description: "Diagnostic électronique complet" },
        { id: "menu_7", title: "Autres prestations", description: "Autres demandes" },
        { id: "menu_8", title: "SAV / Réclamation", description: "Support et réclamations" },
      ],
    }]
  );
}

module.exports = {
  initMediaBuilders,
  DIAGPERF_LOCATION,
  geocodeAddress,
  estimateTravelTime,
  buildTravelEstimateMessage,
  getVehicleImageUrl,
  buildDynoChartUrl,
  buildGainsChartUrl,
  buildSingleStageChartUrl,
  buildVehicleCardUrl,
  buildPrestationCardUrl,
  sendMenuList,
};
