// TRMNL polls `https://www.strava.com/api/v3/athlete/activities?per_page=30`
// (see src/settings.yml) with `Authorization: Bearer {{ oauth_access_token }}`
// already applied, and hands us the raw JSON array as `input` — see
// https://help.trmnl.com/en/articles/12996946-parsing-plugins-with-the-sandbox-runtime.
// This function's only job is to shrink that down to what the four layouts
// actually render (TRMNL enforces a 100kb cap on the *transformed* output,
// same as on a direct/no-transform poll, and a raw activities page can easily
// blow past that on its own).
async function run(input) {
  // --- helpers -------------------------------------------------------------

  // `input` is expected to be the raw array Strava returns from
  // /athlete/activities. Defensive fallbacks in case TRMNL ever wraps it
  // (e.g. `{ body: [...] }` / `{ data: [...] }`) rather than handing back
  // the parsed array directly.
  function activitiesFromInput(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.body)) return raw.body;
    if (raw && Array.isArray(raw.data)) return raw.data;
    return [];
  }

  // TRMNL's docs don't pin down exactly where custom field selections land on
  // the transform input, so check the shapes seen in practice rather than
  // assuming one (same approach as the sibling Vuelta plugins).
  function customField(keyname, fallback) {
    const sources = [
      input?.custom_fields,
      input?.custom_fields_values,
      input?.trmnl?.plugin_settings?.custom_fields_values,
      input?.trmnl?.custom_fields_values
    ];

    for (const source of sources) {
      if (source && typeof source === "object" && source[keyname]) {
        return source[keyname];
      }
    }

    return fallback;
  }

  const HAS_UNSAFE_CHARS = /[<>&"'`]/;
  const UNSAFE_CHAR_REGEX = /[<>&"'`]/g;
  const HTML_ESCAPE_MAP = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;"
  };

  function sanitizeString(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    const str = String(value).slice(0, 300);
    if (!HAS_UNSAFE_CHARS.test(str)) return str;
    return str.replace(UNSAFE_CHAR_REGEX, (char) => HTML_ESCAPE_MAP[char]);
  }

  // Strava's per-activity "timezone" field looks like
  // "(GMT-05:00) America/New_York". There's no single account-level timezone
  // on this endpoint without an extra /athlete fetch, so the most recent
  // ride's timezone is used as the athlete's "home" zone for deciding what
  // "this week" means.
  function ianaFromStravaTimezone(tz) {
    if (typeof tz !== "string") return "Etc/UTC";
    const match = tz.match(/\)\s*(.+)$/);
    return match ? match[1].trim() : "Etc/UTC";
  }

  function dateKeyInZone(date, timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date);
      return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;
    } catch (error) {
      // Unrecognized/invalid IANA zone name — fall back to UTC rather than throwing.
      return dateKeyInZone(date, "Etc/UTC");
    }
  }

  function weekdayShortInZone(date, timeZone) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
    } catch (error) {
      return new Intl.DateTimeFormat("en-US", { timeZone: "Etc/UTC", weekday: "short" }).format(date);
    }
  }

  // Monday–Sunday week window containing `now`, as inclusive YYYY-MM-DD
  // bounds. Activities are bucketed by comparing the date portion of their
  // own `start_date_local` string against these bounds (not a UTC-instant
  // comparison), so a ride that starts late at night in the athlete's local
  // time doesn't get miscounted into the wrong day.
  function currentWeekBounds(now, timeZone) {
    const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    const todayKey = dateKeyInZone(now, timeZone);
    const todayIndex = WEEKDAY_INDEX[weekdayShortInZone(now, timeZone)] ?? 0;

    // Re-anchor to UTC noon on "today" (in the athlete's zone) so day-level
    // arithmetic below can't skip/repeat a day across a DST transition.
    const [y, m, d] = todayKey.split("-").map(Number);
    const todayAnchor = new Date(Date.UTC(y, m - 1, d, 12));
    const monday = new Date(todayAnchor.getTime() - todayIndex * 86400000);
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    return {
      mondayKey: dateKeyInZone(monday, "Etc/UTC"),
      sundayKey: dateKeyInZone(sunday, "Etc/UTC")
    };
  }

  function metersToMiles(meters) {
    return meters / 1609.344;
  }

  function metersToFeet(meters) {
    return meters * 3.28084;
  }

  function formatDistance(meters, unit) {
    if (unit === "Kilometers") return `${(meters / 1000).toFixed(1)} km`;
    return `${metersToMiles(meters).toFixed(1)} mi`;
  }

  function formatElevation(meters, unit) {
    if (unit === "Kilometers") return `${Math.round(meters)} m`;
    return `${Math.round(metersToFeet(meters))} ft`;
  }

  function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.round((totalSeconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    return `${minutes}m`;
  }

  function formatSpeed(metersPerSecond, unit) {
    const value = unit === "Kilometers" ? metersPerSecond * 3.6 : metersPerSecond * 2.23694;
    return `${value.toFixed(1)} ${unit === "Kilometers" ? "km/h" : "mph"}`;
  }

  function mapRide(activity, unit) {
    return {
      id: activity.id,
      name: sanitizeString(activity.name, "Ride"),
      startDateLocal: activity.start_date_local,
      distance: formatDistance(activity.distance || 0, unit),
      movingTime: formatDuration(activity.moving_time || 0),
      elevationGain: formatElevation(activity.total_elevation_gain || 0, unit),
      averageSpeed: activity.average_speed ? formatSpeed(activity.average_speed, unit) : null,
      averageWatts: activity.average_watts ? Math.round(activity.average_watts) : null,
      kudos: activity.kudos_count || 0,
      achievementCount: activity.achievement_count || 0
    };
  }

  // --- main ------------------------------------------------------------

  const distanceUnit = customField("distance_unit", "Miles");
  const activities = activitiesFromInput(input);

  // Rides only, per plugin scope — excludes VirtualRide, EBikeRide,
  // Handcycle, etc. `sport_type` is Strava's current field; the older
  // `type` field is being phased out and collapses some of those
  // categories together, so `sport_type` is the more precise filter.
  const rides = activities
    .filter((a) => a && a.sport_type === "Ride")
    .sort((a, b) => new Date(b.start_date_local) - new Date(a.start_date_local));

  const mostRecentRaw = rides[0] || null;
  const mostRecent = mostRecentRaw ? mapRide(mostRecentRaw, distanceUnit) : null;

  const now = new Date();
  const timeZone = ianaFromStravaTimezone(mostRecentRaw?.timezone);
  const { mondayKey, sundayKey } = currentWeekBounds(now, timeZone);

  const weekRides = rides.filter((a) => {
    const key = String(a.start_date_local).slice(0, 10);
    return key >= mondayKey && key <= sundayKey;
  });

  const weekTotals = weekRides.reduce(
    (acc, a) => {
      acc.distanceMeters += a.distance || 0;
      acc.movingSeconds += a.moving_time || 0;
      acc.elevationMeters += a.total_elevation_gain || 0;
      return acc;
    },
    { distanceMeters: 0, movingSeconds: 0, elevationMeters: 0 }
  );

  const weekly = {
    rideCount: weekRides.length,
    distance: formatDistance(weekTotals.distanceMeters, distanceUnit),
    movingTime: formatDuration(weekTotals.movingSeconds),
    elevationGain: formatElevation(weekTotals.elevationMeters, distanceUnit),
    mondayDate: mondayKey,
    sundayDate: sundayKey,
    rides: weekRides.map((a) => mapRide(a, distanceUnit))
  };

  return {
    hasMostRecent: !!mostRecent,
    mostRecent,
    hasWeekly: weekly.rideCount > 0,
    weekly,
    distanceUnit
  };
}
