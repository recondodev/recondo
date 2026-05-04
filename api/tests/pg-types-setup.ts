/**
 * Vitest setup: register pg type parser for name[] (OID 1003).
 *
 * By default, the `pg` driver does not parse name[] arrays — it returns
 * the raw string "{foo,bar}". This setup registers the text[] parser for
 * name[] so that array_agg(attname) returns a proper JS string[].
 */
import pg from "pg";
import type { TypeId } from "pg-types";

const arrayParser = pg.types.getTypeParser(1009 as unknown as TypeId); // text[] OID
pg.types.setTypeParser(1003 as unknown as TypeId, arrayParser);         // name[] OID
