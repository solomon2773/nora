// marketplace registry backed by PostgreSQL

const db = require("./db");

const LISTING_SOURCE_PLATFORM = "platform";
const LISTING_SOURCE_COMMUNITY = "community";

const LISTING_STATUS_PENDING_REVIEW = "pending_review";
const LISTING_STATUS_PUBLISHED = "published";
const LISTING_STATUS_REJECTED = "rejected";
const LISTING_STATUS_REMOVED = "removed";

const LISTING_VISIBILITY_PUBLIC = "public";

const REPORT_STATUS_OPEN = "open";
const REPORT_STATUS_RESOLVED = "resolved";
const REPORT_STATUS_DISMISSED = "dismissed";

const LISTING_SELECT = `
  SELECT
    ml.id,
    ml.snapshot_id,
    ml.owner_user_id,
    ml.name,
    ml.description,
    ml.price,
    ml.category,
    ml.rating,
    ml.installs,
    ml.downloads,
    ml.built_in,
    ml.source_type,
    ml.status,
    ml.visibility,
    ml.slug,
    ml.current_version,
    ml.review_notes,
    ml.reviewed_at,
    ml.published_at,
    ml.updated_at,
    ml.created_at,
    s.kind AS snapshot_kind,
    s.template_key,
    s.agent_id AS source_agent_id,
    owner.name AS owner_name,
    owner.email AS owner_email,
    COALESCE(report_counts.open_report_count, 0)::int AS open_report_count
  FROM marketplace_listings ml
  LEFT JOIN snapshots s ON s.id = ml.snapshot_id
  LEFT JOIN users owner ON owner.id = ml.owner_user_id
  LEFT JOIN (
    SELECT listing_id, COUNT(*)::int AS open_report_count
    FROM marketplace_reports
    WHERE status = '${REPORT_STATUS_OPEN}'
    GROUP BY listing_id
  ) report_counts ON report_counts.listing_id = ml.id
`;

function normalizeText(value, fallback = "") {
  const normalized =
    typeof value === "string"
      ? value.replace(/[\x00-\x1f\x7f]/g, "").trim()
      : "";
  return normalized || fallback;
}

function normalizeDescription(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCategory(value) {
  return normalizeText(value, "General").slice(0, 60);
}

function normalizePrice(value) {
  return "Free";
}

function normalizeCurrentVersion(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

async function createUniqueSlug(seed, { listingId = null } = {}) {
  const base = slugify(seed) || "listing";

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidate = `${base}${suffix}`;
    const params = listingId ? [candidate, listingId] : [candidate];
    const result = await db.query(
      listingId
        ? "SELECT id FROM marketplace_listings WHERE slug = $1 AND id <> $2 LIMIT 1"
        : "SELECT id FROM marketplace_listings WHERE slug = $1 LIMIT 1",
      params
    );
    if (!result.rows[0]) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}

async function ensureListingVersion({
  listingId,
  snapshotId,
  versionNumber = 1,
  cloneMode = "files_only",
}) {
  if (!listingId || !snapshotId) return;

  const existing = await db.query(
    "SELECT id FROM marketplace_listing_versions WHERE listing_id = $1 AND snapshot_id = $2 LIMIT 1",
    [listingId, snapshotId]
  );
  if (existing.rows[0]) return;

  await db.query(
    `INSERT INTO marketplace_listing_versions(listing_id, snapshot_id, version_number, clone_mode)
     VALUES($1, $2, $3, $4)`,
    [listingId, snapshotId, versionNumber, cloneMode]
  );
}

async function publishSnapshot(
  snapshotId,
  name,
  description,
  price = "Free",
  category = "General",
  options = {}
) {
  return upsertListing({
    snapshotId,
    name,
    description,
    price,
    category,
    builtIn: options.builtIn === true,
    sourceType:
      options.sourceType ||
      (options.builtIn === true
        ? LISTING_SOURCE_PLATFORM
        : LISTING_SOURCE_COMMUNITY),
    ownerUserId: options.ownerUserId || null,
    status: options.status,
    visibility: options.visibility,
    slug: options.slug,
    cloneMode: options.cloneMode || "files_only",
  });
}

async function upsertListing({
  listingId = null,
  snapshotId,
  name,
  description,
  price = "Free",
  category = "General",
  builtIn = false,
  sourceType = builtIn ? LISTING_SOURCE_PLATFORM : LISTING_SOURCE_COMMUNITY,
  ownerUserId = null,
  status = null,
  visibility = LISTING_VISIBILITY_PUBLIC,
  slug = null,
  currentVersion = null,
  reviewNotes = null,
  cloneMode = "files_only",
} = {}) {
  let existing = null;
  if (listingId) {
    const result = await db.query(
      "SELECT * FROM marketplace_listings WHERE id = $1",
      [listingId]
    );
    existing = result.rows[0] || null;
  } else if (snapshotId) {
    const result = await db.query(
      "SELECT * FROM marketplace_listings WHERE snapshot_id = $1 ORDER BY created_at ASC LIMIT 1",
      [snapshotId]
    );
    existing = result.rows[0] || null;
  }

  const normalizedSource =
    sourceType === LISTING_SOURCE_PLATFORM
      ? LISTING_SOURCE_PLATFORM
      : LISTING_SOURCE_COMMUNITY;
  const normalizedBuiltIn = builtIn === true || normalizedSource === LISTING_SOURCE_PLATFORM;
  const normalizedStatus =
    status ||
    existing?.status ||
    (normalizedSource === LISTING_SOURCE_PLATFORM
      ? LISTING_STATUS_PUBLISHED
      : LISTING_STATUS_PENDING_REVIEW);
  const normalizedVisibility =
    visibility === LISTING_VISIBILITY_PUBLIC
      ? LISTING_VISIBILITY_PUBLIC
      : LISTING_VISIBILITY_PUBLIC;
  const normalizedName = normalizeText(name, existing?.name || "Untitled Listing").slice(0, 100);
  const normalizedDescription = normalizeDescription(description || existing?.description || "");
  const normalizedCategory = normalizeCategory(category || existing?.category || "General");
  const normalizedPrice = normalizePrice(price || existing?.price || "Free");
  const resolvedSlug = await createUniqueSlug(
    slug || normalizedName,
    { listingId: existing?.id || null }
  );

  if (existing) {
    const requestedVersion = normalizeCurrentVersion(
      currentVersion,
      existing.current_version || 1
    );
    const nextVersion =
      currentVersion !== null && currentVersion !== undefined
        ? requestedVersion
        : snapshotId && snapshotId !== existing.snapshot_id
          ? (existing.current_version || 1) + 1
          : existing.current_version || 1;
    const result = await db.query(
      `UPDATE marketplace_listings
          SET snapshot_id = COALESCE($1, snapshot_id),
              owner_user_id = COALESCE($2, owner_user_id),
              name = $3,
              description = $4,
              price = $5,
              category = $6,
              built_in = $7,
              source_type = $8,
              status = $9,
              visibility = $10,
              slug = $11,
              current_version = $12,
              review_notes = $13,
              reviewed_at = CASE WHEN $9 IN ('published', 'rejected', 'removed') THEN NOW() ELSE reviewed_at END,
              published_at = CASE
                WHEN $9 = 'published' THEN COALESCE(published_at, NOW())
                ELSE published_at
              END,
              updated_at = NOW()
        WHERE id = $14
      RETURNING *`,
      [
        snapshotId || null,
        ownerUserId || null,
        normalizedName,
        normalizedDescription,
        normalizedPrice,
        normalizedCategory,
        normalizedBuiltIn,
        normalizedSource,
        normalizedStatus,
        normalizedVisibility,
        resolvedSlug,
        nextVersion,
        reviewNotes,
        existing.id,
      ]
    );

    await ensureListingVersion({
      listingId: existing.id,
      snapshotId: snapshotId || existing.snapshot_id,
      versionNumber: nextVersion,
      cloneMode,
    });

    return result.rows[0];
  }

  const initialVersion = normalizeCurrentVersion(currentVersion, 1);
  const result = await db.query(
    `INSERT INTO marketplace_listings(
       snapshot_id,
       owner_user_id,
       name,
       description,
       price,
       category,
       built_in,
       source_type,
       status,
       visibility,
       slug,
       current_version,
       published_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       CASE WHEN $9 = 'published' THEN NOW() ELSE NULL END
     )
     RETURNING *`,
    [
      snapshotId || null,
      ownerUserId || null,
      normalizedName,
      normalizedDescription,
      normalizedPrice,
      normalizedCategory,
      normalizedBuiltIn,
      normalizedSource,
      normalizedStatus,
      normalizedVisibility,
      resolvedSlug,
      initialVersion,
    ]
  );

  await ensureListingVersion({
    listingId: result.rows[0].id,
    snapshotId,
    versionNumber: initialVersion,
    cloneMode,
  });

  return result.rows[0];
}

async function listMarketplace() {
  const result = await db.query(
    `${LISTING_SELECT}
      WHERE ml.status = $1
        AND ml.visibility = $2
      ORDER BY
        CASE WHEN ml.source_type = '${LISTING_SOURCE_PLATFORM}' THEN 0 ELSE 1 END,
        ml.installs DESC,
        COALESCE(ml.published_at, ml.created_at) DESC`,
    [LISTING_STATUS_PUBLISHED, LISTING_VISIBILITY_PUBLIC]
  );
  return result.rows;
}

async function listUserListings(userId) {
  const result = await db.query(
    `${LISTING_SELECT}
      WHERE ml.owner_user_id = $1
      ORDER BY ml.updated_at DESC, ml.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function listAdminListings() {
  const result = await db.query(
    `${LISTING_SELECT}
      ORDER BY
        CASE
          WHEN ml.status = '${LISTING_STATUS_PENDING_REVIEW}' THEN 0
          WHEN ml.status = '${LISTING_STATUS_PUBLISHED}' THEN 1
          WHEN ml.status = '${LISTING_STATUS_REJECTED}' THEN 2
          ELSE 3
        END,
        ml.updated_at DESC,
        ml.created_at DESC`
  );
  return result.rows;
}

async function getListing(id) {
  const result = await db.query(
    `${LISTING_SELECT}
      WHERE ml.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getPlatformListingByTemplateKey(templateKey) {
  if (!templateKey) return null;
  const result = await db.query(
    `${LISTING_SELECT}
      WHERE ml.source_type = $1
        AND s.template_key = $2
      ORDER BY ml.updated_at DESC
      LIMIT 1`,
    [LISTING_SOURCE_PLATFORM, templateKey]
  );
  return result.rows[0] || null;
}

async function recordInstall(id) {
  await db.query(
    "UPDATE marketplace_listings SET installs = COALESCE(installs, 0) + 1, updated_at = NOW() WHERE id = $1",
    [id]
  );
}

async function recordDownload(id) {
  await db.query(
    "UPDATE marketplace_listings SET downloads = COALESCE(downloads, 0) + 1, updated_at = NOW() WHERE id = $1",
    [id]
  );
}

async function createReport({
  listingId,
  reporterUserId,
  reason,
  details = "",
} = {}) {
  const existing = await db.query(
    `SELECT id
       FROM marketplace_reports
      WHERE listing_id = $1
        AND reporter_user_id = $2
        AND status = $3
      LIMIT 1`,
    [listingId, reporterUserId, REPORT_STATUS_OPEN]
  );
  if (existing.rows[0]) {
    const error = new Error("You already have an open report for this listing");
    error.statusCode = 409;
    throw error;
  }

  const result = await db.query(
    `INSERT INTO marketplace_reports(listing_id, reporter_user_id, reason, details)
     VALUES($1, $2, $3, $4)
     RETURNING *`,
    [
      listingId,
      reporterUserId || null,
      normalizeText(reason, "other").slice(0, 80),
      normalizeDescription(details),
    ]
  );
  return result.rows[0];
}

async function listReports() {
  const result = await db.query(
    `SELECT
       mr.id,
       mr.listing_id,
       mr.reporter_user_id,
       mr.reason,
       mr.details,
       mr.status,
       mr.reviewed_at,
       mr.created_at,
       ml.name AS listing_name,
       ml.status AS listing_status,
       ml.source_type,
       owner.name AS owner_name,
       owner.email AS owner_email,
       reporter.email AS reporter_email
     FROM marketplace_reports mr
     LEFT JOIN marketplace_listings ml ON ml.id = mr.listing_id
     LEFT JOIN users owner ON owner.id = ml.owner_user_id
     LEFT JOIN users reporter ON reporter.id = mr.reporter_user_id
     ORDER BY
       CASE WHEN mr.status = '${REPORT_STATUS_OPEN}' THEN 0 ELSE 1 END,
       mr.created_at DESC`
  );
  return result.rows;
}

async function resolveReport(reportId, reviewerUserId, status = REPORT_STATUS_RESOLVED) {
  const normalizedStatus =
    status === REPORT_STATUS_DISMISSED
      ? REPORT_STATUS_DISMISSED
      : REPORT_STATUS_RESOLVED;
  const result = await db.query(
    `UPDATE marketplace_reports
        SET status = $1,
            reviewed_at = NOW(),
            reviewed_by = $2
      WHERE id = $3
      RETURNING *`,
    [normalizedStatus, reviewerUserId || null, reportId]
  );
  return result.rows[0] || null;
}

async function setListingStatus(
  id,
  status,
  reviewerUserId = null,
  reviewNotes = null
) {
  const normalizedStatus =
    [
      LISTING_STATUS_PENDING_REVIEW,
      LISTING_STATUS_PUBLISHED,
      LISTING_STATUS_REJECTED,
      LISTING_STATUS_REMOVED,
    ].includes(status)
      ? status
      : LISTING_STATUS_PENDING_REVIEW;
  const result = await db.query(
    `UPDATE marketplace_listings
        SET status = $1,
            reviewed_at = NOW(),
            reviewed_by = $2,
            review_notes = $3,
            published_at = CASE
              WHEN $1 = '${LISTING_STATUS_PUBLISHED}' THEN COALESCE(published_at, NOW())
              ELSE published_at
            END,
            updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
    [normalizedStatus, reviewerUserId || null, normalizeDescription(reviewNotes), id]
  );

  if (!result.rows[0]) return null;

  await db.query(
    `UPDATE marketplace_reports
        SET status = $1,
            reviewed_at = NOW(),
            reviewed_by = $2
      WHERE listing_id = $3
        AND status = $4`,
    [REPORT_STATUS_RESOLVED, reviewerUserId || null, id, REPORT_STATUS_OPEN]
  );

  return result.rows[0];
}

async function deleteListing(id) {
  await db.query("DELETE FROM marketplace_listings WHERE id = $1", [id]);
}

module.exports = {
  LISTING_SOURCE_COMMUNITY,
  LISTING_SOURCE_PLATFORM,
  LISTING_STATUS_PENDING_REVIEW,
  LISTING_STATUS_PUBLISHED,
  LISTING_STATUS_REJECTED,
  LISTING_STATUS_REMOVED,
  LISTING_VISIBILITY_PUBLIC,
  REPORT_STATUS_DISMISSED,
  REPORT_STATUS_OPEN,
  REPORT_STATUS_RESOLVED,
  createReport,
  deleteListing,
  getListing,
  getPlatformListingByTemplateKey,
  listAdminListings,
  listMarketplace,
  listReports,
  listUserListings,
  publishSnapshot,
  recordDownload,
  recordInstall,
  resolveReport,
  setListingStatus,
  upsertListing,
};
