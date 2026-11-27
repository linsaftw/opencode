import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261127183842_session_list_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_v2_project_idx\`;`)
      yield* tx.run(
        `CREATE INDEX \`session_v2_project_time_id_idx\` ON \`session_v2\` (\`project_id\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_v2_directory_time_id_idx\` ON \`session_v2\` (\`directory\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_v2_time_id_idx\` ON \`session_v2\` (\`time_updated\`,\`id\`);`)
    })
  },
}

export default migration
