export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = {'Cache-Control': 'no-store'};

export async function POST(): Promise<Response> {
  return Response.json({status: 'not_found'}, {status: 404, headers: noStore});
}
