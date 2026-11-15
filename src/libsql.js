// libSQL(Turso) 데이터베이스를 src/db.js 가 요구하는 모양으로 감쌉니다.
// 네트워크 너머에 있어서 질의마다 기다려야 하는(sync: false) 저장소입니다.
//
// client 는 @libsql/client 의 createClient() 로 만든 것을 넘겨받습니다.
// Vercel 에서는 원격 주소(libsql://...)로, 테스트에서는 내 컴퓨터의 파일(file:...)로 만듭니다.

function operations(target) {
  return {
    async get(sql, ...args) {
      return (await target.execute({ sql, args })).rows[0];
    },
    async all(sql, ...args) {
      return (await target.execute({ sql, args })).rows;
    },
    async run(sql, ...args) {
      await target.execute({ sql, args });
    },
    async exec(sql) {
      await target.executeMultiple(sql);
    },
  };
}

export class LibsqlDatabase {
  sync = false;
  #client;
  #queue = null;

  // serialize: 질의를 한 번에 하나씩만 보냅니다. 파일로 열었을 때는 동시에 쓰면 "database is locked" 가 나므로 켭니다.
  // 원격 데이터베이스는 서버가 순서를 맞춰 주므로 끕니다.
  constructor(client, { serialize = false } = {}) {
    this.#client = client;
    if (serialize) this.#queue = Promise.resolve();
    const direct = operations(client);
    for (const name of Object.keys(direct)) this[name] = (...args) => this.#enqueue(() => direct[name](...args));
  }

  #enqueue(task) {
    if (!this.#queue) return task();
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }

  // work(tx) 안의 질의는 모두 한 트랜잭션으로 실행되고, 예외가 나면 되돌립니다.
  transaction(work) {
    return this.#enqueue(async () => {
      const tx = await this.#client.transaction('write');
      try {
        const value = await work(operations(tx));
        await tx.commit();
        return value;
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw error;
      } finally {
        tx.close();
      }
    });
  }

  close() {
    this.#client.close();
  }
}
