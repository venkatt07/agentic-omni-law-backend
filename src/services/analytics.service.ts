import { createHash, randomUUID } from "crypto";
import { mysqlPool } from "../prisma/client.js";

type TrackPayload = {
  event_name?: string;
  path: string;
  title?: string | null;
  visitor_id: string;
  session_id: string;
  referrer?: string | null;
  locale?: string | null;
  timezone?: string | null;
  viewport_width?: number | null;
  viewport_height?: number | null;
  screen_width?: number | null;
  screen_height?: number | null;
  country_code?: string | null;
  country_name?: string | null;
  region_name?: string | null;
  city_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

type TrackMeta = {
  userId?: string | null;
  requestId?: string | null;
  userAgent?: string | null;
  ip?: string | null;
};

type GeoLookupResult = {
  countryCode: string | null;
  countryName: string | null;
  regionName: string | null;
  cityName: string | null;
  latitude: number | null;
  longitude: number | null;
};

type RegionRow = {
  region: string;
  users: number;
  views: number;
  share: number;
  latitude: number | null;
  longitude: number | null;
};

const geoCache = new Map<string, Promise<GeoLookupResult>>();
const DAY_LABEL = new Intl.DateTimeFormat("en-IN", { month: "short", day: "2-digit", timeZone: "UTC" });

function hashIp(ip?: string | null) {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 40);
}

function normalizeIp(value?: string | null) {
  const raw = String(value || "").split(",")[0]?.trim();
  if (!raw) return null;
  if (raw === "::1" || raw === "127.0.0.1") return null;
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(raw)) return null;
  return raw;
}

function parseDeviceType(userAgent?: string | null, viewportWidth?: number | null) {
  const ua = String(userAgent || "").toLowerCase();
  if (/ipad|tablet|sm-t|tab/.test(ua)) return "Tablet";
  if (/iphone|android.+mobile|mobile/.test(ua)) return "Mobile";
  if (typeof viewportWidth === "number" && viewportWidth > 0) {
    if (viewportWidth <= 768) return "Mobile";
    if (viewportWidth <= 1024) return "Tablet";
  }
  return "Desktop";
}

function parsePlatform(userAgent?: string | null) {
  const ua = String(userAgent || "").toLowerCase();
  if (ua.includes("iphone")) return "iPhone";
  if (ua.includes("ipad")) return "iPad";
  if (ua.includes("android")) return "Android";
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macOS";
  if (ua.includes("linux")) return "Linux";
  return "Other";
}

function parseBrowser(userAgent?: string | null) {
  const ua = String(userAgent || "").toLowerCase();
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("opr/") || ua.includes("opera")) return "Opera";
  if (ua.includes("chrome/") && !ua.includes("edg/")) return "Chrome";
  if (ua.includes("safari/") && !ua.includes("chrome/")) return "Safari";
  if (ua.includes("firefox/")) return "Firefox";
  return "Other";
}

function lastNDays(days: number) {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (days - index - 1));
    const iso = date.toISOString().slice(0, 10);
    return { iso, label: DAY_LABEL.format(date) };
  });
}

function toIsoDay(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value || "").trim();
  const direct = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const fallback = new Date();
  fallback.setUTCHours(0, 0, 0, 0);
  return fallback.toISOString().slice(0, 10);
}

async function columnExists(columnName: string) {
  const [rows]: any = await mysqlPool.query(
    `
      SELECT COUNT(*) AS count
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'analytics_events'
        AND COLUMN_NAME = ?
    `,
    [columnName],
  );
  return Number(rows?.[0]?.count || 0) > 0;
}

async function bestEffortGeoLookup(ip?: string | null): Promise<GeoLookupResult> {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return {
      countryCode: null,
      countryName: null,
      regionName: null,
      cityName: null,
      latitude: null,
      longitude: null,
    };
  }
  const cached = geoCache.get(normalized);
  if (cached) return cached;

  const request = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const response = await fetch(`https://ipwho.is/${encodeURIComponent(normalized)}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`geo lookup failed: ${response.status}`);
      const payload: any = await response.json();
      if (payload?.success === false) throw new Error("geo lookup rejected");
      return {
        countryCode: payload?.country_code ? String(payload.country_code) : null,
        countryName: payload?.country ? String(payload.country) : null,
        regionName: payload?.region ? String(payload.region) : null,
        cityName: payload?.city ? String(payload.city) : null,
        latitude: Number.isFinite(Number(payload?.latitude)) ? Number(payload.latitude) : null,
        longitude: Number.isFinite(Number(payload?.longitude)) ? Number(payload.longitude) : null,
      } satisfies GeoLookupResult;
    } catch {
      return {
        countryCode: null,
        countryName: null,
        regionName: null,
        cityName: null,
        latitude: null,
        longitude: null,
      } satisfies GeoLookupResult;
    }
  })();

  geoCache.set(normalized, request);
  return request;
}

async function scalarNumber(sql: string, params: any[] = []) {
  const [rows]: any = await mysqlPool.query(sql, params);
  const first = rows?.[0] || {};
  const value = first[Object.keys(first)[0]];
  return Number(value || 0);
}

export const analyticsService = {
  async ensureSchema() {
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id VARCHAR(191) NOT NULL,
        event_name VARCHAR(64) NOT NULL,
        path VARCHAR(191) NOT NULL,
        title VARCHAR(191) NULL,
        visitor_id VARCHAR(191) NOT NULL,
        session_id VARCHAR(191) NOT NULL,
        user_id VARCHAR(191) NULL,
        request_id VARCHAR(191) NULL,
        referrer VARCHAR(512) NULL,
        locale VARCHAR(64) NULL,
        timezone VARCHAR(96) NULL,
        viewport_width INT NULL,
        viewport_height INT NULL,
        screen_width INT NULL,
        screen_height INT NULL,
        device_type VARCHAR(32) NOT NULL,
        platform VARCHAR(32) NOT NULL,
        browser VARCHAR(32) NOT NULL,
        ip_hash VARCHAR(191) NULL,
        user_agent VARCHAR(512) NULL,
        country_code VARCHAR(8) NULL,
        country_name VARCHAR(128) NULL,
        region_name VARCHAR(128) NULL,
        city_name VARCHAR(128) NULL,
        latitude DECIMAL(10,7) NULL,
        longitude DECIMAL(10,7) NULL,
        occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        INDEX idx_analytics_events_occurred_at (occurred_at DESC),
        INDEX idx_analytics_events_path (path),
        INDEX idx_analytics_events_event_path (event_name, path),
        INDEX idx_analytics_events_device (device_type, platform),
        INDEX idx_analytics_events_visitor (visitor_id, occurred_at DESC),
        INDEX idx_analytics_events_session (session_id, occurred_at DESC),
        INDEX idx_analytics_events_user (user_id, occurred_at DESC),
        INDEX idx_analytics_events_region (country_code, region_name, occurred_at DESC)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    const missingColumns = [
      ["country_code", "ALTER TABLE analytics_events ADD COLUMN country_code VARCHAR(8) NULL AFTER user_agent"],
      ["country_name", "ALTER TABLE analytics_events ADD COLUMN country_name VARCHAR(128) NULL AFTER country_code"],
      ["region_name", "ALTER TABLE analytics_events ADD COLUMN region_name VARCHAR(128) NULL AFTER country_name"],
      ["city_name", "ALTER TABLE analytics_events ADD COLUMN city_name VARCHAR(128) NULL AFTER region_name"],
      ["latitude", "ALTER TABLE analytics_events ADD COLUMN latitude DECIMAL(10,7) NULL AFTER city_name"],
      ["longitude", "ALTER TABLE analytics_events ADD COLUMN longitude DECIMAL(10,7) NULL AFTER latitude"],
    ] as const;

    for (const [name, sql] of missingColumns) {
      if (!(await columnExists(name))) {
        await mysqlPool.query(sql);
      }
    }
  },

  async trackPageEvent(payload: TrackPayload, meta: TrackMeta) {
    const userAgent = String(meta.userAgent || "").slice(0, 512) || null;
    const deviceType = parseDeviceType(userAgent, payload.viewport_width ?? null);
    const platform = parsePlatform(userAgent);
    const browser = parseBrowser(userAgent);
    const resolvedGeo =
      payload.country_code || payload.region_name || payload.city_name || payload.latitude != null || payload.longitude != null
        ? {
            countryCode: payload.country_code ? String(payload.country_code).slice(0, 8) : null,
            countryName: payload.country_name ? String(payload.country_name).slice(0, 128) : null,
            regionName: payload.region_name ? String(payload.region_name).slice(0, 128) : null,
            cityName: payload.city_name ? String(payload.city_name).slice(0, 128) : null,
            latitude: typeof payload.latitude === "number" ? payload.latitude : null,
            longitude: typeof payload.longitude === "number" ? payload.longitude : null,
          }
        : await bestEffortGeoLookup(meta.ip);

    await mysqlPool.query(
      `
        INSERT INTO analytics_events (
          id, event_name, path, title, visitor_id, session_id, user_id, request_id, referrer, locale, timezone,
          viewport_width, viewport_height, screen_width, screen_height, device_type, platform, browser,
          ip_hash, user_agent, country_code, country_name, region_name, city_name, latitude, longitude,
          occurred_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?,
          NOW(3), NOW(3), NOW(3)
        )
      `,
      [
        randomUUID(),
        String(payload.event_name || "page_view").slice(0, 64),
        String(payload.path || "/").slice(0, 191),
        payload.title ? String(payload.title).slice(0, 191) : null,
        String(payload.visitor_id || "").slice(0, 191),
        String(payload.session_id || "").slice(0, 191),
        meta.userId || null,
        meta.requestId || null,
        payload.referrer ? String(payload.referrer).slice(0, 512) : null,
        payload.locale ? String(payload.locale).slice(0, 64) : null,
        payload.timezone ? String(payload.timezone).slice(0, 96) : null,
        payload.viewport_width ?? null,
        payload.viewport_height ?? null,
        payload.screen_width ?? null,
        payload.screen_height ?? null,
        deviceType,
        platform,
        browser,
        hashIp(meta.ip),
        userAgent,
        resolvedGeo.countryCode,
        resolvedGeo.countryName,
        resolvedGeo.regionName,
        resolvedGeo.cityName,
        resolvedGeo.latitude,
        resolvedGeo.longitude,
      ],
    );

    if (
      payload.visitor_id &&
      (resolvedGeo.countryCode || resolvedGeo.regionName || resolvedGeo.cityName || resolvedGeo.latitude != null || resolvedGeo.longitude != null)
    ) {
      await mysqlPool.query(
        `
          UPDATE analytics_events
          SET
            country_code = COALESCE(country_code, ?),
            country_name = COALESCE(country_name, ?),
            region_name = COALESCE(region_name, ?),
            city_name = COALESCE(city_name, ?),
            latitude = COALESCE(latitude, ?),
            longitude = COALESCE(longitude, ?),
            updated_at = NOW(3)
          WHERE visitor_id = ?
            AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)
            AND (
              country_code IS NULL OR country_code = '' OR
              region_name IS NULL OR region_name = '' OR
              city_name IS NULL OR city_name = '' OR
              latitude IS NULL OR
              longitude IS NULL
            )
        `,
        [
          resolvedGeo.countryCode,
          resolvedGeo.countryName,
          resolvedGeo.regionName,
          resolvedGeo.cityName,
          resolvedGeo.latitude,
          resolvedGeo.longitude,
          String(payload.visitor_id).slice(0, 191),
        ],
      );
    }

    return { ok: true };
  },

  async getOverview() {
    const [
      registered_users,
      verified_users,
      active_cases,
      successful_runs_30d,
      page_views_30d,
      unique_visitors_30d,
      active_visitors_24h,
      mobile_visitors_30d,
      desktop_visitors_30d,
      iphone_visitors_30d,
    ] = await Promise.all([
      scalarNumber("SELECT COUNT(*) AS c FROM users"),
      scalarNumber("SELECT COUNT(*) AS c FROM users WHERE is_verified = 1"),
      scalarNumber("SELECT COUNT(*) AS c FROM cases WHERE status = 'active'"),
      scalarNumber("SELECT COUNT(*) AS c FROM runs WHERE status = 'SUCCEEDED' AND created_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)"),
      scalarNumber("SELECT COUNT(*) AS c FROM analytics_events WHERE event_name = 'page_view' AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)"),
      scalarNumber("SELECT COUNT(DISTINCT visitor_id) AS c FROM analytics_events WHERE event_name = 'page_view' AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)"),
      scalarNumber("SELECT COUNT(DISTINCT visitor_id) AS c FROM analytics_events WHERE event_name = 'page_view' AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 24 HOUR)"),
      scalarNumber("SELECT COUNT(DISTINCT visitor_id) AS c FROM analytics_events WHERE event_name = 'page_view' AND device_type = 'Mobile' AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)"),
      scalarNumber("SELECT COUNT(DISTINCT visitor_id) AS c FROM analytics_events WHERE event_name = 'page_view' AND device_type = 'Desktop' AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)"),
      scalarNumber("SELECT COUNT(DISTINCT visitor_id) AS c FROM analytics_events WHERE event_name = 'page_view' AND platform = 'iPhone' AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)"),
    ]);

    const [deviceRows]: any = await mysqlPool.query(
      `
        SELECT
          device_type AS key_name,
          device_type AS label,
          COUNT(*) AS page_views,
          COUNT(DISTINCT visitor_id) AS visitors
        FROM analytics_events
        WHERE event_name = 'page_view'
          AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)
        GROUP BY device_type
        ORDER BY visitors DESC, page_views DESC
      `,
    );

    const [platformRows]: any = await mysqlPool.query(
      `
        SELECT
          platform AS key_name,
          platform AS label,
          COUNT(*) AS page_views,
          COUNT(DISTINCT visitor_id) AS visitors
        FROM analytics_events
        WHERE event_name = 'page_view'
          AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)
        GROUP BY platform
        ORDER BY visitors DESC, page_views DESC
        LIMIT 6
      `,
    );

    const [viewRows]: any = await mysqlPool.query(
      `
        SELECT
          DATE(occurred_at) AS day_iso,
          COUNT(*) AS page_views,
          COUNT(DISTINCT visitor_id) AS visitors
        FROM analytics_events
        WHERE event_name = 'page_view'
          AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY)
        GROUP BY DATE(occurred_at)
        ORDER BY DATE(occurred_at) ASC
      `,
    );

    const [topPages]: any = await mysqlPool.query(
      `
        SELECT
          path,
          COUNT(*) AS page_views,
          COUNT(DISTINCT visitor_id) AS visitors
        FROM analytics_events
        WHERE event_name = 'page_view'
          AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)
        GROUP BY path
        ORDER BY page_views DESC, visitors DESC, path ASC
        LIMIT 6
      `,
    );

    const totalVisitors = Math.max(unique_visitors_30d, 1);
    const byDaySeed = new Map(lastNDays(14).map((day) => [day.iso, { day: day.label, page_views: 0, visitors: 0 }]));
    for (const row of viewRows || []) {
      const iso = toIsoDay(row.day_iso);
      const existing = byDaySeed.get(iso);
      if (existing) {
        existing.page_views = Number(row.page_views || 0);
        existing.visitors = Number(row.visitors || 0);
      }
    }

    return {
      generated_at: new Date().toISOString(),
      totals: {
        registered_users,
        verified_users,
        active_cases,
        successful_runs_30d,
        page_views_30d,
        unique_visitors_30d,
        active_visitors_24h,
        mobile_visitors_30d,
        desktop_visitors_30d,
        iphone_visitors_30d,
      },
      devices: (deviceRows || []).map((row: any) => ({
        key: String(row.key_name || row.label || "other").toLowerCase(),
        label: String(row.label || "Other"),
        page_views: Number(row.page_views || 0),
        visitors: Number(row.visitors || 0),
        share: Math.round((Number(row.visitors || 0) / totalVisitors) * 100),
      })),
      platforms: (platformRows || []).map((row: any) => ({
        key: String(row.key_name || row.label || "other").toLowerCase(),
        label: String(row.label || "Other"),
        page_views: Number(row.page_views || 0),
        visitors: Number(row.visitors || 0),
      })),
      views_by_day: Array.from(byDaySeed.values()),
      top_pages: (topPages || []).map((row: any) => ({
        path: String(row.path || "/"),
        page_views: Number(row.page_views || 0),
        visitors: Number(row.visitors || 0),
      })),
    };
  },

  async getDashboardAnalytics(userId: string | null) {
    const overview = await this.getOverview();

    const [browserRows]: any = await mysqlPool.query(
      `
        SELECT
          browser AS key_name,
          browser AS label,
          COUNT(*) AS page_views,
          COUNT(DISTINCT visitor_id) AS visitors
        FROM analytics_events
        WHERE event_name = 'page_view'
          AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)
        GROUP BY browser
        ORDER BY visitors DESC, page_views DESC
        LIMIT 6
      `,
    );

    const [trendRows]: any = await mysqlPool.query(
      `
        SELECT
          day.day_iso,
          COALESCE(pv.page_views, 0) AS page_views,
          COALESCE(pv.visitors, 0) AS visitors,
          COALESCE(rn.runs, 0) AS runs
        FROM (
          SELECT DATE(UTC_TIMESTAMP() - INTERVAL seq.n DAY) AS day_iso
          FROM (
            SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL
            SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL
            SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL
            SELECT 12 UNION ALL SELECT 13
          ) AS seq
        ) AS day
        LEFT JOIN (
          SELECT DATE(occurred_at) AS day_iso, COUNT(*) AS page_views, COUNT(DISTINCT visitor_id) AS visitors
          FROM analytics_events
          WHERE event_name = 'page_view'
            AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY)
          GROUP BY DATE(occurred_at)
        ) AS pv ON pv.day_iso = day.day_iso
        LEFT JOIN (
          SELECT DATE(created_at) AS day_iso, COUNT(*) AS runs
          FROM runs
          WHERE status = 'SUCCEEDED'
            AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY)
          GROUP BY DATE(created_at)
        ) AS rn ON rn.day_iso = day.day_iso
        ORDER BY day.day_iso ASC
      `,
    );

    const myUsage =
      userId
        ? await (async () => {
            const [myRows]: any = await mysqlPool.query(
              `
                SELECT
                  COUNT(*) AS page_views_30d,
                  COUNT(DISTINCT session_id) AS sessions_30d
                FROM analytics_events
                WHERE event_name = 'page_view'
                  AND user_id = ?
                  AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)
              `,
              [userId],
            );

            const [myCasesRows]: any = await mysqlPool.query("SELECT COUNT(*) AS c FROM cases WHERE user_id = ?", [userId]);
            const [myRunsRows]: any = await mysqlPool.query(
              `
                SELECT COUNT(*) AS c
                FROM runs r
                INNER JOIN cases c ON c.id = r.case_id
                WHERE c.user_id = ?
              `,
              [userId],
            );

            return {
              page_views_30d: Number(myRows?.[0]?.page_views_30d || 0),
              sessions_30d: Number(myRows?.[0]?.sessions_30d || 0),
              cases_total: Number(myCasesRows?.[0]?.c || 0),
              runs_total: Number(myRunsRows?.[0]?.c || 0),
            };
          })()
        : {
            page_views_30d: 0,
            sessions_30d: 0,
            cases_total: 0,
            runs_total: 0,
          };

    const [regionRows]: any = await mysqlPool.query(
      `
        SELECT
          COALESCE(NULLIF(region_name, ''), city_name, 'Unknown') AS region_name,
          COUNT(DISTINCT visitor_id) AS users,
          COUNT(*) AS views,
          ROUND(AVG(latitude), 6) AS latitude,
          ROUND(AVG(longitude), 6) AS longitude
        FROM analytics_events
        WHERE event_name = 'page_view'
          AND occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)
          AND country_code = 'IN'
        GROUP BY COALESCE(NULLIF(region_name, ''), city_name, 'Unknown')
        ORDER BY users DESC, views DESC, region_name ASC
        LIMIT 12
      `,
    );

    const regionalTotal = Math.max(
      (regionRows || []).reduce((sum: number, row: any) => sum + Number(row.users || 0), 0),
      1,
    );

    return {
      ...overview,
      browsers: (browserRows || []).map((row: any) => ({
        key: String(row.key_name || row.label || "other").toLowerCase(),
        label: String(row.label || "Other"),
        page_views: Number(row.page_views || 0),
        visitors: Number(row.visitors || 0),
      })),
      trends_14d: (trendRows || []).map((row: any) => ({
        day: DAY_LABEL.format(new Date(`${toIsoDay(row.day_iso)}T00:00:00.000Z`)),
        page_views: Number(row.page_views || 0),
        visitors: Number(row.visitors || 0),
        runs: Number(row.runs || 0),
      })),
      my_usage: myUsage,
      india_regions: (regionRows || []).map((row: any): RegionRow => ({
        region: String(row.region_name || "Unknown"),
        users: Number(row.users || 0),
        views: Number(row.views || 0),
        share: Math.round((Number(row.users || 0) / regionalTotal) * 100),
        latitude: row.latitude == null ? null : Number(row.latitude),
        longitude: row.longitude == null ? null : Number(row.longitude),
      })),
    };
  },
};
