/**
 * Hargeisa forecast via Open-Meteo (free, no API key).
 * Docs: https://open-meteo.com/en/docs — ECMWF / GFS blend at ~11 km.
 */

const HARGEISA_LAT = 9.5616;
const HARGEISA_LON = 44.065;
/** East Africa Time matches Somaliland civil time. */
const TIMEZONE = "Africa/Nairobi";

export type HargeisaWeatherBrief = {
  fetchedAt: string;
  locationLabel: string;
  elevationM: number;
  /** ISO time string for current conditions from API */
  currentTimeIso: string;
  currentTempC: number;
  currentWeatherCode: number;
  currentSummary: string;
  isDay: boolean;
  todayDateIso: string;
  todayHighC: number;
  todayLowC: number;
  todayRainMm: number;
  todayRainChancePct: number | null;
  /** Max precip probability in next 24 h (model hourly). */
  next24hMaxRainChancePct: number;
  /** Sum of hourly precipitation next 24 h (mm). */
  next24hRainMm: number;
  /** Highest hourly temperature next 24 h */
  next24hMaxTempC: number;
  alerts: Array<{ kind: "rain" | "heat" | "info"; text: string }>;
};

function wmoWeatherLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Mostly clear / cloudy";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  if (code <= 99) return "Thunderstorm";
  return "Mixed conditions";
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchHargeisaWeather(signal?: AbortSignal): Promise<HargeisaWeatherBrief | null> {
  const params = new URLSearchParams({
    latitude: String(HARGEISA_LAT),
    longitude: String(HARGEISA_LON),
    current: "temperature_2m,precipitation,rain,weather_code,is_day",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weather_code",
    timezone: TIMEZONE,
    forecast_days: "4",
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    elevation?: number;
    current?: Record<string, unknown>;
    hourly?: { time?: string[]; temperature_2m?: number[]; precipitation_probability?: number[]; precipitation?: number[] };
    daily?: {
      time?: string[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_sum?: number[];
      precipitation_probability_max?: number[];
    };
  };

  const elevationM = num(data.elevation) ?? 1340;
  const cur = data.current ?? {};
  const currentTempC = num(cur.temperature_2m) ?? 0;
  const currentWeatherCode = Math.round(num(cur.weather_code) ?? 0);
  const isDay = Boolean(cur.is_day);
  const currentTimeIso = typeof cur.time === "string" ? cur.time : new Date().toISOString();

  const hourly = data.hourly;
  const times = hourly?.time ?? [];
  const temps = hourly?.temperature_2m ?? [];
  const probs = hourly?.precipitation_probability ?? [];
  const precips = hourly?.precipitation ?? [];

  const now = Date.now();
  let startIdx = 0;
  for (let i = 0; i < times.length; i += 1) {
    const t = new Date(times[i]).getTime();
    if (t >= now - 30 * 60 * 1000) {
      startIdx = i;
      break;
    }
    startIdx = i;
  }

  const horizon = Math.min(times.length, startIdx + 24);
  let next24hMaxRainChancePct = 0;
  let next24hRainMm = 0;
  let next24hMaxTempC = currentTempC;
  for (let i = startIdx; i < horizon; i += 1) {
    const p = num(probs[i]) ?? 0;
    next24hMaxRainChancePct = Math.max(next24hMaxRainChancePct, p);
    next24hRainMm += Math.max(0, num(precips[i]) ?? 0);
    const tc = num(temps[i]);
    if (tc !== null) next24hMaxTempC = Math.max(next24hMaxTempC, tc);
  }

  const daily = data.daily;
  const todayDateIso = daily?.time?.[0] ?? currentTimeIso.slice(0, 10);
  const todayHighC = num(daily?.temperature_2m_max?.[0]) ?? next24hMaxTempC;
  const todayLowC = num(daily?.temperature_2m_min?.[0]) ?? currentTempC;
  const todayRainMm = Math.max(0, num(daily?.precipitation_sum?.[0]) ?? 0);
  const todayRainChancePct = num(daily?.precipitation_probability_max?.[0]);

  const alerts: HargeisaWeatherBrief["alerts"] = [];

  const rainSignalsStrong =
    next24hRainMm >= 4 ||
    todayRainMm >= 3 ||
    next24hMaxRainChancePct >= 70 ||
    (todayRainChancePct !== null && todayRainChancePct >= 65);

  const rainSignalsModerate =
    next24hRainMm >= 1 ||
    todayRainMm >= 1 ||
    next24hMaxRainChancePct >= 45 ||
    (todayRainChancePct !== null && todayRainChancePct >= 40) ||
    ([61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(currentWeatherCode));

  if (rainSignalsStrong) {
    alerts.push({
      kind: "rain",
      text: `Heavy rain possible (~${Math.round(next24hMaxRainChancePct)}% peak chance).`,
    });
  } else if (rainSignalsModerate) {
    alerts.push({
      kind: "rain",
      text: `Showers possible (~${Math.round(next24hMaxRainChancePct)}%).`,
    });
  }

  const peakC = Math.round(Math.max(todayHighC, next24hMaxTempC));
  if (todayHighC >= 36 || next24hMaxTempC >= 36) {
    alerts.push({
      kind: "heat",
      text: `Very hot (~${peakC}°). Take shade midday.`,
    });
  } else if (todayHighC >= 33 || next24hMaxTempC >= 33) {
    alerts.push({
      kind: "heat",
      text: `Hot (~${peakC}°).`,
    });
  } else if (todayHighC >= 30 || next24hMaxTempC >= 30) {
    alerts.push({
      kind: "heat",
      text: `Warm (~${peakC}°).`,
    });
  }

  return {
    fetchedAt: new Date().toISOString(),
    locationLabel: "Hargeisa",
    elevationM,
    currentTimeIso,
    currentTempC,
    currentWeatherCode,
    currentSummary: wmoWeatherLabel(currentWeatherCode),
    isDay,
    todayDateIso,
    todayHighC,
    todayLowC,
    todayRainMm,
    todayRainChancePct,
    next24hMaxRainChancePct,
    next24hRainMm,
    next24hMaxTempC,
    alerts,
  };
}
