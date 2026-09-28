export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ========================================================
    // CORS
    // ========================================================

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // ========================================================
    // API ROUTES
    // ========================================================

    if (url.pathname.startsWith("/api")) {
      return handleAPI(request, env, url, corsHeaders);
    }

    // ========================================================
    // WEBSITE
    // ========================================================

    return env.ASSETS.fetch(request);
  },
};


// ==========================================================
// API HANDLER
// ==========================================================

async function handleAPI(
  request,
  env,
  url,
  corsHeaders
) {

  try {

    // --------------------------------------------------------
    // API ROOT
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      (url.pathname === "/api" ||
       url.pathname === "/api/")
    ) {

      return json(
        {
          ok: true,
          service: "Threader API",
          version: "1.0.0",

          endpoints: {
            status: "GET /api/status",

            autothread_config:
              "GET /api/autothread/config",

            autothread_save:
              "POST /api/autothread/config",

            autothread_disable:
              "DELETE /api/autothread/config",

            autothread_next:
              "POST /api/autothread/next",

            autothread_reset:
              "POST /api/autothread/reset",

            events:
              "POST /api/events",
          },
        },
        200,
        corsHeaders
      );
    }


    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/api/status"
    ) {

      let database = false;

      if (env.DB) {
        try {
          await env.DB
            .prepare("SELECT 1")
            .first();

          database = true;

        } catch (error) {
          console.error(
            "D1 status check failed:",
            error
          );
        }
      }

      return json(
        {
          ok: true,
          online: true,
          service: "Threader API",
          database,
          timestamp:
            new Date().toISOString(),
        },
        200,
        corsHeaders
      );
    }


    // --------------------------------------------------------
    // AUTHENTICATION
    // --------------------------------------------------------

    if (env.WORKER_SECRET) {

      const authorization =
        request.headers.get(
          "Authorization"
        );

      if (
        authorization !==
        `Bearer ${env.WORKER_SECRET}`
      ) {

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


    // --------------------------------------------------------
    // MAKE SURE D1 EXISTS
    // --------------------------------------------------------

    if (!env.DB) {

      return json(
        {
          ok: false,
          error:
            "D1 database binding is missing.",
        },
        500,
        corsHeaders
      );
    }


    // --------------------------------------------------------
    // GET AUTOTHREAD CONFIG
    // --------------------------------------------------------

    if (
      request.method === "GET" &&
      url.pathname === "/api/autothread/config"
    ) {

      const guildId =
        url.searchParams.get(
          "guild_id"
        );

      const channelId =
        url.searchParams.get(
          "channel_id"
        );


      if (!guildId || !channelId) {

        return json(
          {
            ok: false,
            error:
              "guild_id and channel_id are required.",
          },
          400,
          corsHeaders
        );
      }


      const row =
        await env.DB
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
          .bind(
            guildId,
            channelId
          )
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
            guild_id:
              row.guild_id,

            channel_id:
              row.channel_id,

            keyword:
              row.keyword,

            thread_name:
              row.thread_name,

            counter:
              Number(row.counter),

            auto_archive_duration:
              Number(
                row.auto_archive_duration
              ),

            enabled:
              Boolean(row.enabled),
          },
        },
        200,
        corsHeaders
      );
    }


    // --------------------------------------------------------
    // CREATE / UPDATE AUTOTHREAD
    // --------------------------------------------------------

    if (
      request.method === "POST" &&
      url.pathname === "/api/autothread/config"
    ) {

      const body =
        await request.json();


      const guildId =
        String(
          body.guild_id || ""
        ).trim();

      const channelId =
        String(
          body.channel_id || ""
        ).trim();

      const keyword =
        String(
          body.keyword || ""
        ).trim();

      const threadName =
        String(
          body.thread_name || ""
        ).trim();


      const counter =
        Number(
          body.counter ?? 1
        );

      const autoArchive =
        Number(
          body.auto_archive_duration ??
          1440
        );

      const enabled =
        body.enabled === false
          ? 0
          : 1;


      if (
        !guildId ||
        !channelId
      ) {

        return json(
          {
            ok: false,
            error:
              "guild_id and channel_id are required.",
          },
          400,
          corsHeaders
        );
      }


      if (!keyword) {

        return json(
          {
            ok: false,
            error:
              "keyword is required.",
          },
          400,
          corsHeaders
        );
      }


      if (!threadName) {

        return json(
          {
            ok: false,
            error:
              "thread_name is required.",
          },
          400,
          corsHeaders
        );
      }


      if (
        !threadName.includes(
          "{number}"
        )
      ) {

        return json(
          {
            ok: false,
            error:
              "thread_name must contain {number}.",
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
              "counter must be a positive integer.",
          },
          400,
          corsHeaders
        );
      }


      const validArchives = [
        60,
        1440,
        4320,
        10080,
      ];

      if (
        !validArchives.includes(
          autoArchive
        )
      ) {

        return json(
          {
            ok: false,
            error:
              "Invalid auto archive duration.",
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
            enabled = excluded.enabled,
            updated_at = CURRENT_TIMESTAMP
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
          message:
            "Auto-thread configuration saved.",
        },
        200,
        corsHeaders
      );
    }


    // --------------------------------------------------------
    // DISABLE AUTOTHREAD
    // --------------------------------------------------------

    if (
      request.method === "DELETE" &&
      url.pathname === "/api/autothread/config"
    ) {

      const guildId =
        url.searchParams.get(
          "guild_id"
        );

      const channelId =
        url.searchParams.get(
          "channel_id"
        );


      if (!guildId || !channelId) {

        return json(
          {
            ok: false,
            error:
              "guild_id and channel_id are required.",
          },
          400,
          corsHeaders
        );
      }


      await env.DB
        .prepare(`
          UPDATE autothreads
          SET
            enabled = 0,
            updated_at = CURRENT_TIMESTAMP
          WHERE guild_id = ?
            AND channel_id = ?
        `)
        .bind(
          guildId,
          channelId
        )
        .run();


      return json(
        {
          ok: true,
          message:
            "Auto-thread disabled.",
        },
        200,
        corsHeaders
      );
    }


    // --------------------------------------------------------
    // GET NEXT NUMBER
    // --------------------------------------------------------

    if (
      request.method === "POST" &&
      url.pathname === "/api/autothread/next"
    ) {

      const body =
        await request.json();


      const guildId =
        String(
          body.guild_id || ""
        ).trim();

      const channelId =
        String(
          body.channel_id || ""
        ).trim();


      if (
        !guildId ||
        !channelId
      ) {

        return json(
          {
            ok: false,
            error:
              "guild_id and channel_id are required.",
          },
          400,
          corsHeaders
        );
      }


      /*
       * Increment and return the previous value.
       *
       * This uses D1's RETURNING support so the
       * counter allocation happens in one SQL
       * statement instead of a SELECT followed
       * by an UPDATE.
       */

      const row =
        await env.DB
          .prepare(`
            UPDATE autothreads

            SET
              counter = counter + 1,
              updated_at = CURRENT_TIMESTAMP

            WHERE guild_id = ?
              AND channel_id = ?
              AND enabled = 1

            RETURNING
              counter - 1 AS assigned_number
          `)
          .bind(
            guildId,
            channelId
          )
          .first();


      if (!row) {

        return json(
          {
            ok: false,
            error:
              "Auto-threading is not enabled.",
          },
          404,
          corsHeaders
        );
      }


      return json(
        {
          ok: true,
          number:
            Number(
              row.assigned_number
            ),
        },
        200,
        corsHeaders
      );
    }


    // --------------------------------------------------------
    // RESET COUNTER
    // --------------------------------------------------------

    if (
      request.method === "POST" &&
      url.pathname === "/api/autothread/reset"
    ) {

      const body =
        await request.json();


      const guildId =
        String(
          body.guild_id || ""
        ).trim();

      const channelId =
        String(
          body.channel_id || ""
        ).trim();

      const counter =
        Number(body.counter);


      if (
        !guildId ||
        !channelId
      ) {

        return json(
          {
            ok: false,
            error:
              "guild_id and channel_id are required.",
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
              "counter must be a positive integer.",
          },
          400,
          corsHeaders
        );
      }


      const result =
        await env.DB
          .prepare(`
            UPDATE autothreads
            SET
              counter = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE guild_id = ?
              AND channel_id = ?
          `)
          .bind(
            counter,
            guildId,
            channelId
          )
          .run();


      if (
        result.meta.changes === 0
      ) {

        return json(
          {
            ok: false,
            error:
              "Auto-thread configuration not found.",
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


    // --------------------------------------------------------
    // EVENTS
    // --------------------------------------------------------

    if (
      request.method === "POST" &&
      url.pathname === "/api/events"
    ) {

      const body =
        await request.json();


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


    // --------------------------------------------------------
    // UNKNOWN API ROUTE
    // --------------------------------------------------------

    return json(
      {
        ok: false,
        error:
          "API endpoint not found.",
      },
      404,
      corsHeaders
    );

  } catch (error) {

    console.error(
      "Threader API error:",
      error
    );


    return json(
      {
        ok: false,
        error:
          "Internal server error.",
      },
      500,
      corsHeaders
    );
  }
}


// ==========================================================
// JSON HELPER
// ==========================================================

function json(
  data,
  status = 200,
  extraHeaders = {}
) {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "Content-Type":
          "application/json",

        ...extraHeaders,
      },
    }
  );
}
