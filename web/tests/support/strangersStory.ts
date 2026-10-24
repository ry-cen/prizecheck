// Set-up for the Trading Stage 2 end-to-end stories (trade-strangers-story.spec.ts, #305): the one zip the shared
// `seedZips` leaves out. The stories need two collectors about 3 mi apart, which 00010 and 00011 (6.9 mi) are not.
import { Pool } from "pg";

/** Seeds 00013, 0.043 degrees (about 3.0 mi) north of 00010, next to the fixed rows `seedZips` upserts. Upserts. */
export async function seedNearbyZip() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO zip_centroid (zip, lat, lon, source) VALUES ('00013', 40.043, -100.0, 'census')
       ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, source = EXCLUDED.source`
    );
  } finally {
    await pool.end();
  }
}
