import {sql} from 'drizzle-orm';
import {NextResponse} from 'next/server';
import {createDatabase} from '@fai-control-plane/db';
import {checkHermesSemanticPlannerHealth, hermesSemanticPlanningConfiguration} from '../../../src/hermes-semantic-planner';

export const dynamic = 'force-dynamic';

export async function GET() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return NextResponse.json(
      {status: 'not_ready', service: 'web', checks: {database: 'unavailable'}},
      {status: 503, headers: {'Cache-Control': 'no-store'}}
    );
  }

  const {db, pool} = createDatabase(databaseUrl);

  try {
    await db.execute(sql`select 1`);
    const planning = hermesSemanticPlanningConfiguration();
    const planner = planning.configured ? await checkHermesSemanticPlannerHealth() : null;
    if (planning.configured && planner?.healthy !== true) {
      return NextResponse.json(
        {status: 'not_ready', service: 'web', checks: {database: 'ok', hermesPlanner: 'failed'}},
        {status: 503, headers: {'Cache-Control': 'no-store'}}
      );
    }
    return NextResponse.json(
      {status: 'ready', service: 'web', checks: {database: 'ok', hermesPlanner: planning.configured ? 'ok' : 'disabled'}},
      {headers: {'Cache-Control': 'no-store'}}
    );
  } catch {
    return NextResponse.json(
      {status: 'not_ready', service: 'web', checks: {database: 'failed'}},
      {status: 503, headers: {'Cache-Control': 'no-store'}}
    );
  } finally {
    await pool.end();
  }
}
