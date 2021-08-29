import arg from 'arg';
import fse from 'fs-extra';
import * as path from 'path';
import inquirer from 'inquirer';
import { Database } from 'sqlite3';
import * as z from 'zod';
import fastify from 'fastify';
import fastifyCors from 'fastify-cors';
import HttpErrors from 'http-errors';
import { isPlainObject } from 'is-plain-object';
import produce from 'immer';

export const QuerySchema = z.object({
  _type: z.literal('query'),
  mode: z.enum(['get', 'all']),
  query: z.string(),
  params: z.array(z.any()).optional()
});

export type Query = z.infer<typeof QuerySchema>;

export type QueryResult<Data> = { success: true; data: Data } | { success: false; error: string };

export async function command() {
  const args = arg({
    '--file': String,
    '--port': Number,
    '--help': Boolean,
    '--origin': [String],
    // alias
    '-f': '--file',
    '-p': '--port',
    '-h': '--help',
    '-o': '--origin'
  });

  const readmePath = path.resolve(__dirname, '..', 'README.md');
  const help = await fse.readFile(readmePath, { encoding: 'utf8' });

  if (args['--help']) {
    console.log(help);
    return;
  }

  const port = args['--port'];
  const file = args['--file'] || args._[0];
  if (!file) {
    throw new Error('Missing file param !');
  }
  if (!file.endsWith('.db')) {
    throw new Error('File must be a .db file !');
  }
  if (!port) {
    throw new Error('Missing port param');
  }
  const origin = args['--origin'] ?? [];

  const filePath = path.resolve(process.cwd(), file);
  const fileExist = fse.existsSync(filePath);
  if (fileExist === false) {
    const createFile = (
      await inquirer.prompt([
        {
          name: 'confirm',
          type: 'confirm',
          message: `The database ${filePath} does not exist and will be created`
        }
      ])
    ).confirm;
    if (!createFile) {
      return;
    }
    await fse.ensureDir(path.dirname(filePath));
  }

  const db = await connectDb(filePath);

  const server = fastify();

  server.register(fastifyCors, {
    origin: origin.length === 0 ? '*' : origin
  });

  server.get('/', async () => {
    return help;
  });

  server.post('/', async (request, reply) => {
    if (typeof request.body !== 'object') {
      reply.send(new HttpErrors.BadRequest(`Body must be JSON`));
      return;
    }
    const queries = extractQueries(request.body);
    const results = await runQueries(queries, db);
    const result = buildResult(request.body, results);
    return result;
  });

  try {
    await server.listen(port, '0.0.0.0');
    console.log(`Server is listening on http://0.0.0.0:${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

function connectDb(file: string): Promise<Database> {
  return new Promise((resolve, reject) => {
    const db = new Database(file, err => {
      if (err) {
        reject(err);
      } else {
        resolve(db);
      }
    });
  });
}

type Path = Array<string | number>;

type QueryWithPath = {
  path: Path;
  query: Query;
};

function extractQueries(data: unknown, path: Path = []): Array<QueryWithPath> {
  if (Array.isArray(data)) {
    return data.map((item, index) => extractQueries(item, [...path, index])).flat();
  }
  if (data === null || data === undefined || typeof data === 'string' || typeof data === 'number') {
    return [];
  }
  if (!isPlainObject(data)) {
    throw new HttpErrors.BadRequest(`Object at path "${path.join('.')}" is not valid`);
  }
  const obj = data as { [key: string]: any };
  if ('_type' in obj && obj._type === 'query') {
    const parsed = QuerySchema.safeParse(obj);
    if (parsed.success === false) {
      throw new HttpErrors.BadRequest(
        `Query at path "${path.join('.')}" is not valid.\n${parsed.error.toString()}`
      );
    }
    return [
      {
        path,
        query: parsed.data
      }
    ];
  }
  return Object.entries(obj)
    .map(([key, item]) => {
      return extractQueries(item, [...path, key]);
    })
    .flat();
}

type QueryWithResult = QueryWithPath & { result: QueryResult<any> };

async function runQueries(
  queries: Array<QueryWithPath>,
  db: Database
): Promise<Array<QueryWithResult>> {
  return Promise.all(
    queries.map(
      async ({ path, query }): Promise<QueryWithResult> => {
        try {
          const data = await dbAsync(db, query.mode, query.query, query.params ?? []);
          return { path, query, result: { success: true, data } };
        } catch (error) {
          return { path, query, result: { success: false, error: String(error) } };
        }
      }
    )
  );
}

function dbAsync(
  db: Database,
  method: 'get' | 'all',
  query: string,
  params: Array<any> = []
): Promise<any> {
  return new Promise((resolve, reject) => {
    db[method](query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function buildResult(body: any, results: Array<QueryWithResult>): any {
  return produce(body, (draft: any) => {
    results.forEach(({ path, result }) => {
      let current = draft;
      const access = path.slice(0, -1);
      const last = path[path.length - 1];
      access.forEach(key => {
        current = current[key];
      });
      current[last] = result;
    });
  });
}
