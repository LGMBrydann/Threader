export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // --------------------------------------------------------
    // Authentication
    // --------------------------------------------------------

    if (env.WORKER_SECRET) {
      const auth = request.headers.get("Authorization");

      if (auth !== `Bearer ${env.WORKER_SECRET}`) {
        return json(
          {
            ok: false,
            error: "Unauthorized",
          },
          401,
          corsHeaders
        );
      }
    }

    try {
      // ------------------------------------------------------
      // STATUS
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/api/status"
      ) {
        return json(
          {
            ok: true,
            online: true,
            service: "Threader API",
            database: Boolean(env.DB),
            timestamp: new Date().toISOString(),
          },
          200,
          corsHeaders
        );
      }

      // ------------------------------------------------------
      // GET AUTOTHREAD CONFIG
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/api/autothread/config"
      ) {
        const guildId = url.searchParams.get("guild_id");
        const channelId = url.searchParams.get("channel_id");

        if (!guildId || !channelId) {
          return json(
            {
              ok: false,
              error: "guild_id and channel_id are required",
            },
            400,
            corsHeaders
          );
        }

        const row = await env.DB
          .prepare(`
            SELECT
              guild_id,
              channel_id,
              keyword,
              thread_name,
              counter,
              auto_archive_duration,
              enabled
            FROM autothreads
            WHERE guild_id = ?
              AND channel_id = ?
            LIMIT 1
          `)
          .bind(guildId, channelId)
          .first();

        if (!row) {
          return json(
            {
              ok: true,
              config: null,
            },
            200,
            corsHeaders
          );
        }

        return json(
          {
            ok: true,
            config: {
              guild_id: row.guild_id,
              channel_id: row.channel_id,
              keyword: row.keyword,
              thread_name: row.thread_name,
              counter: row.counter,
              auto_archive_duration:
                row.auto_archive_duration,
              enabled: Boolean(row.enabled),
            },
          },
          200,
          corsHeaders
        );
      }

      // ------------------------------------------------------
      // CREATE / UPDATE AUTOTHREAD CONFIG
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/api/autothread/config"
      ) {
        const body = await request.json();

        const guildId = String(body.guild_id || "");
        const channelId = String(body.channel_id || "");
        const keyword = String(body.keyword || "").trim();
        const threadName =
          String(body.thread_name || "").trim();

        const counter = Number(
          body.counter ?? 1
        );

        const autoArchive = Number(
          body.auto_archive_duration ?? 1440
        );

        const enabled = body.enabled === false ? 0 : 1;

        if (!guildId || !channelId) {
          return json(
            {
              ok: false,
              error: "guild_id and channel_id are required",
            },
            400,
            corsHeaders
          );
        }

        if (!keyword) {
          return json(
            {
              ok: false,
              error: "keyword is required",
            },
            400,
            corsHeaders
          );
        }

        if (!threadName) {
          return json(
            {
              ok: false,
              error: "thread_name is required",
            },
            400,
            corsHeaders
          );
        }

        if (
          !threadName.includes("{number}")
        ) {
          return json(
            {
              ok: false,
              error:
                "thread_name must contain {number}",
            },
            400,
            corsHeaders
          );
        }

        if (
          !Number.isInteger(counter) ||
          counter < 1
        ) {
          return json(
            {
              ok: false,
              error:
                "counter must be a positive integer",
            },
            400,
            corsHeaders
          );
        }

        await env.DB
          .prepare(`
            INSERT INTO autothreads (
              guild_id,
              channel_id,
              keyword,
              thread_name,
              counter,
              auto_archive_duration,
              enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)

            ON CONFLICT(guild_id, channel_id)
            DO UPDATE SET
              keyword = excluded.keyword,
              thread_name = excluded.thread_name,
              counter = excluded.counter,
              auto_archive_duration =
                excluded.auto_archive_duration,
              enabled = excluded.enabled
          `)
          .bind(
            guildId,
            channelId,
            keyword,
            threadName,
            counter,
            autoArchive,
            enabled
          )
          .run();

        return json(
          {
            ok: true,
            message: "Auto-thread configuration saved",
          },
          200,
          corsHeaders
        );
      }

      // ------------------------------------------------------
      // DISABLE AUTOTHREAD
      // ------------------------------------------------------

      if (
        request.method === "DELETE" &&
        url.pathname === "/api/autothread/config"
      ) {
        const guildId = url.searchParams.get("guild_id");
        const channelId = url.searchParams.get("channel_id");

        if (!guildId || !channelId) {
          return json(
            {
              ok: false,
              error: "guild_id and channel_id are required",
            },
            400,
            corsHeaders
          );
        }

        await env.DB
          .prepare(`
            UPDATE autothreads
            SET enabled = 0
            WHERE guild_id = ?
              AND channel_id = ?
          `)
          .bind(guildId, channelId)
          .run();

        return json(
          {
            ok: true,
            message: "Auto-thread disabled",
          },
          200,
          corsHeaders
        );
      }

      // ------------------------------------------------------
      // GET NEXT NUMBER
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/api/autothread/next"
      ) {
        const body = await request.json();

        const guildId = String(body.guild_id || "");
        const channelId = String(body.channel_id || "");

        if (!guildId || !channelId) {
          return json(
            {
              ok: false,
              error: "guild_id and channel_id are required",
            },
            400,
            corsHeaders
          );
        }

        /*
         * Increment the counter and return the number that
         * was assigned to this thread.
         *
         * The counter stored in the database represents
         * the NEXT number to use.
         */

        const row = await env.DB
          .prepare(`
            SELECT counter
            FROM autothreads
            WHERE guild_id = ?
              AND channel_id = ?
              AND enabled = 1
            LIMIT 1
          `)
          .bind(guildId, channelId)
          .first();

        if (!row) {
          return json(
            {
              ok: false,
              error: "Auto-threading is not enabled",
            },
            404,
            corsHeaders
          );
        }

        const number = Number(row.counter);

        await env.DB
          .prepare(`
            UPDATE autothreads
            SET counter = counter + 1
            WHERE guild_id = ?
              AND channel_id = ?
              AND enabled = 1
          `)
          .bind(guildId, channelId)
          .run();

        return json(
          {
            ok: true,
            number,
          },
          200,
          corsHeaders
        );
      }

      // ------------------------------------------------------
      // RESET COUNTER
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/api/autothread/reset"
      ) {
        const body = await request.json();

        const guildId = String(body.guild_id || "");
        const channelId = String(body.channel_id || "");
        const counter = Number(body.counter);

        if (!guildId || !channelId) {
          return json(
            {
              ok: false,
              error: "guild_id and channel_id are required",
            },
            400,
            corsHeaders
          );
        }

        if (
          !Number.isInteger(counter) ||
          counter < 1
        ) {
          return json(
            {
              ok: false,
              error: "counter must be a positive integer",
            },
            400,
            corsHeaders
          );
        }

        const result = await env.DB
          .prepare(`
            UPDATE autothreads
            SET counter = ?
            WHERE guild_id = ?
              AND channel_id = ?
          `)
          .bind(
            counter,
            guildId,
            channelId
          )
          .run();

        if (result.meta.changes === 0) {
          return json(
            {
              ok: false,
              error: "Auto-thread configuration not found",
            },
            404,
            corsHeaders
          );
        }

        return json(
          {
            ok: true,
            counter,
          },
          200,
          corsHeaders
        );
      }

      // ------------------------------------------------------
      // EVENTS
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/api/events"
      ) {
        const body = await request.json();

        console.log(
          "Threader event:",
          JSON.stringify(body)
        );

        return json(
          {
            ok: true,
          },
          200,
          corsHeaders
        );
      }

      // ------------------------------------------------------
      // NOT FOUND
      // ------------------------------------------------------

      return json(
        {
          ok: false,
          error: "Not found",
        },
        404,
        corsHeaders
      );

    } catch (error) {

      console.error(
        "Worker error:",
        error
      );

      return json(
        {
          ok: false,
          error: "Internal server error",
        },
        500,
        corsHeaders
      );
    }
  },
};


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
  data,
  status = 200,
  extraHeaders = {}
) {

  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    }
  );
}
