import pg from 'pg';

// DATE en chaîne ISO (YYYY-MM-DD) plutôt qu'en Date JS : une date de golf
// est une date locale, sans fuseau.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// int8 (count, sum) en number : les volumes manipulés restent petits.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 20 });
}

/** Exécute fn dans une transaction READ COMMITTED ; les verrous de ligne et
 *  verrous consultatifs pris dedans sont libérés au COMMIT/ROLLBACK. */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
