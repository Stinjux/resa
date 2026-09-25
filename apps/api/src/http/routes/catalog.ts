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

  app.get('/api/clubs/:clubId/resource-types', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    await getClub(deps.db, clubId);
    return { resourceTypes: await listResourceTypes(deps.db, clubId) };
  });
}
