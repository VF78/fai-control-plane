export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const noStore = {'Cache-Control': 'no-store'};

// Deployment bearer credentials are never accepted on a browser/TCP route. A
// separately authorized, owner-bound Unix-socket server must compose the service.
export async function POST(): Promise<Response> {
  return Response.json({status: 'not_found'}, {status: 404, headers: noStore});
}
