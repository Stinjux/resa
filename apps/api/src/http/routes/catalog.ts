import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getClub, listClubs, listCourses, listResourceTypes } from '../../modules/catalog/repository.js';
import type { AppDeps } from '../server.js';

export function catalogRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/api/clubs', async () => ({ clubs: await listClubs(deps.db) }));

  app.get('/api/clubs/:clubId/courses', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    await getClub(deps.db, clubId);
    return { courses: await listCourses(deps.db, clubId) };
  });

  // Catégories tarifaires configurées (standard, résident…).
  app.get('/api/clubs/:clubId/customer-categories', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    const { rows } = await deps.db.query(
      `SELECT DISTINCT customer_category AS c FROM tariffs WHERE club_id = $1 AND active AND customer_category IS NOT NULL ORDER BY 1`,
      [clubId],
    );
    return { categories: ['standard', ...rows.map((r) => r.c).filter((c) => c !== 'standard')] };
  });

  app.get('/api/clubs/:clubId/resource-types', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    await getClub(deps.db, clubId);
    return { resourceTypes: await listResourceTypes(deps.db, clubId) };
  });
}
