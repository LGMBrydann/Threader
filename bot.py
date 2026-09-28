import os
import re
import aiohttp
import discord

from discord import app_commands
from discord.ext import commands


# ============================================================
# CONFIG
# ============================================================

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")

WORKER_URL = os.getenv(
    "THREAD_API_URL",
    "https://thread-api.yeeter.workers.dev"
).rstrip("/")

WORKER_SECRET = os.getenv("THREAD_WORKER_SECRET")


# ============================================================
# INTENTS
# ============================================================

intents = discord.Intents.default()

# Required so the bot can see messages and detect keywords.
intents.message_content = True


# ============================================================
# BOT
# ============================================================

class Threader(commands.Bot):

    def __init__(self):
        super().__init__(
            command_prefix="!",
            intents=intents
        )

    async def setup_hook(self):
        await self.tree.sync()
        print("Slash commands synced.")

    async def on_ready(self):
        print(f"Logged in as {self.user} ({self.user.id})")
        print(f"Worker API: {WORKER_URL}")


bot = Threader()


# ============================================================
# WORKER API
# ============================================================

async def worker_request(
    method: str,
    path: str,
    payload=None
):
    """
    Sends a request to the Cloudflare Worker.
    """

    url = f"{WORKER_URL}{path}"

    headers = {
        "Content-Type": "application/json"
    }

    if WORKER_SECRET:
        headers["Authorization"] = f"Bearer {WORKER_SECRET}"

    timeout = aiohttp.ClientTimeout(total=10)

    try:
        async with aiohttp.ClientSession(
            timeout=timeout
        ) as session:

            async with session.request(
                method,
                url,
                json=payload,
                headers=headers
            ) as response:

                text = await response.text()

                try:
                    data = await response.json()
                except Exception:
                    data = {
                        "ok": False,
                        "error": text
                    }

                if response.status >= 400:
                    return None, data

                return response.status, data

    except Exception as exc:
        print(f"Worker request failed: {exc}")

        return None, {
            "ok": False,
            "error": str(exc)
        }


# ============================================================
# AUTO-THREAD HELPERS
# ============================================================

def keyword_matches(
    content: str,
    keyword: str
) -> bool:
    """
    Case-insensitive whole-word keyword matching.

    Examples:

        QOTD: hello       -> MATCH
        qotd #2           -> MATCH
        [QOTD] hello      -> MATCH

        QOTD123           -> NO MATCH
        myqotd            -> NO MATCH
    """

    pattern = rf"(?<!\w){re.escape(keyword)}(?!\w)"

    return re.search(
        pattern,
        content,
        re.IGNORECASE
    ) is not None


async def create_auto_thread(
    message: discord.Message,
    config: dict
):
    """
    Gets the next persistent number from the Worker,
    then creates the Discord thread.
    """

    guild_id = message.guild.id
    channel_id = message.channel.id

    # Ask Worker for the next number.
    status, result = await worker_request(
        "POST",
        "/api/autothread/next",
        {
            "guild_id": str(guild_id),
            "channel_id": str(channel_id)
        }
    )

    if status != 200 or not result.get("ok"):
        print(
            "Could not get auto-thread number:",
            result
        )

        return

    number = result["number"]

    # Replace {number} in the configured thread name.
    template = config["thread_name"]

    thread_name = template.replace(
        "{number}",
        str(number)
    )

    # Discord has a maximum thread-name length.
    thread_name = thread_name[:100]

    try:
        thread = await message.create_thread(
            name=thread_name,
            auto_archive_duration=config.get(
                "auto_archive_duration",
                1440
            )
        )

    except discord.Forbidden:
        print(
            f"Missing permissions to create a thread "
            f"in #{message.channel}"
        )
        return

    except discord.HTTPException as exc:
        print(
            f"Discord failed to create auto-thread: {exc}"
        )
        return

    # Tell the Worker what Discord thread was created.
    await worker_request(
        "POST",
        "/api/events",
        {
            "event": "autothread_created",
            "guild_id": str(guild_id),
            "channel_id": str(channel_id),
            "message_id": str(message.id),
            "thread_id": str(thread.id),
            "number": number,
            "thread_name": thread.name
        }
    )

    print(
        f"Created auto-thread #{number}: "
        f"{thread.name}"
    )


# ============================================================
# MESSAGE LISTENER
# ============================================================

@bot.event
async def on_message(
    message: discord.Message
):

    # Ignore ourselves and other bots.
    if message.author.bot:
        return

    # Auto-threading only works inside servers.
    if message.guild is None:
        return

    # Ask Worker if this channel has auto-threading enabled.
    status, result = await worker_request(
        "GET",
        (
            "/api/autothread/config"
            f"?guild_id={message.guild.id}"
            f"&channel_id={message.channel.id}"
        )
    )

    if status == 200 and result.get("ok"):
        config = result.get("config")

        if config and config.get("enabled"):

            keyword = config.get("keyword")

            if keyword and keyword_matches(
                message.content,
                keyword
            ):

                await create_auto_thread(
                    message,
                    config
                )

    # Keep normal bot functionality working.
    await bot.process_commands(message)


# ============================================================
# /THREAD COMMAND GROUP
# ============================================================

thread_group = app_commands.Group(
    name="thread",
    description="Create and manage Discord threads."
)

bot.tree.add_command(thread_group)


# ============================================================
# /THREAD CREATE
# ============================================================

@thread_group.command(
    name="create",
    description="Create a thread from a message."
)
@app_commands.describe(
    name="The name of the thread."
)
async def thread_create(
    interaction: discord.Interaction,
    name: str
):

    if not isinstance(
        interaction.channel,
        discord.TextChannel
    ):
        await interaction.response.send_message(
            "❌ This command must be used in a text channel.",
            ephemeral=True
        )
        return

    try:
        thread = await interaction.channel.create_thread(
            name=name[:100],
            auto_archive_duration=1440
        )

    except discord.Forbidden:
        await interaction.response.send_message(
            "❌ I don't have permission to create threads here.",
            ephemeral=True
        )
        return

    except discord.HTTPException as exc:
        await interaction.response.send_message(
            f"❌ Discord rejected the thread: `{exc}`",
            ephemeral=True
        )
        return

    await worker_request(
        "POST",
        "/api/events",
        {
            "event": "thread_created",
            "guild_id": str(interaction.guild.id)
            if interaction.guild else None,
            "channel_id": str(interaction.channel.id),
            "thread_id": str(thread.id),
            "thread_name": thread.name,
            "user_id": str(interaction.user.id)
        }
    )

    await interaction.response.send_message(
        f"✅ Created {thread.mention}",
        ephemeral=True
    )


# ============================================================
# /AUTOTHREAD SETUP
# ============================================================

autothread_group = app_commands.Group(
    name="autothread",
    description="Automatically create threads when keywords are posted."
)

bot.tree.add_command(autothread_group)


@autothread_group.command(
    name="setup",
    description="Enable automatic threads for this channel."
)
@app_commands.describe(
    keyword="The keyword that triggers the thread.",
    thread_name="Thread name. Use {number} for the counter.",
    starting_number="Number to use for the first matching message.",
    auto_archive="How long threads stay open."
)
@app_commands.choices(
    auto_archive=[
        app_commands.Choice(
            name="1 hour",
            value=60
        ),
        app_commands.Choice(
            name="24 hours",
            value=1440
        ),
        app_commands.Choice(
            name="3 days",
            value=4320
        ),
        app_commands.Choice(
            name="7 days",
            value=10080
        )
    ]
)
@app_commands.checks.has_permissions(
    manage_threads=True
)
async def autothread_setup(
    interaction: discord.Interaction,
    keyword: str,
    thread_name: str,
    starting_number: int = 1,
    auto_archive: app_commands.Choice[int] = None
):

    if interaction.guild is None:
        await interaction.response.send_message(
            "❌ This command only works in a server.",
            ephemeral=True
        )
        return

    if not isinstance(
        interaction.channel,
        discord.TextChannel
    ):
        await interaction.response.send_message(
            "❌ Run this in the channel you want to watch.",
            ephemeral=True
        )
        return

    if starting_number < 1:
        await interaction.response.send_message(
            "❌ Starting number must be at least `1`.",
            ephemeral=True
        )
        return

    if len(keyword) > 100:
        await interaction.response.send_message(
            "❌ The keyword must be 100 characters or less.",
            ephemeral=True
        )
        return

    if "{number}" not in thread_name:
        await interaction.response.send_message(
            "❌ Your thread name must contain `{number}`.\n\n"
            "Example: `QOTD Answers #{number}`",
            ephemeral=True
        )
        return

    archive_minutes = (
        auto_archive.value
        if auto_archive
        else 1440
    )

    status, result = await worker_request(
        "POST",
        "/api/autothread/config",
        {
            "guild_id": str(interaction.guild.id),
            "channel_id": str(interaction.channel.id),
            "keyword": keyword,
            "thread_name": thread_name[:100],
            "counter": starting_number,
            "auto_archive_duration": archive_minutes,
            "enabled": True
        }
    )

    if status != 200 or not result.get("ok"):
        await interaction.response.send_message(
            "❌ Couldn't save the auto-thread configuration.\n"
            f"`{result.get('error', 'Unknown error')}`",
            ephemeral=True
        )
        return

    embed = discord.Embed(
        title="⚡ Auto-thread enabled",
        description=(
            f"I'll watch {interaction.channel.mention} "
            f"for **{keyword}**."
        ),
        color=discord.Color.blurple()
    )

    embed.add_field(
        name="Keyword",
        value=f"`{keyword}`",
        inline=True
    )

    embed.add_field(
        name="Thread name",
        value=f"`{thread_name}`",
        inline=True
    )

    embed.add_field(
        name="Starting number",
        value=str(starting_number),
        inline=True
    )

    await interaction.response.send_message(
        embed=embed,
        ephemeral=True
    )


# ============================================================
# /AUTOTHREAD DISABLE
# ============================================================

@autothread_group.command(
    name="disable",
    description="Disable automatic threads in this channel."
)
@app_commands.checks.has_permissions(
    manage_threads=True
)
async def autothread_disable(
    interaction: discord.Interaction
):

    if interaction.guild is None:
        await interaction.response.send_message(
            "❌ This only works in a server.",
            ephemeral=True
        )
        return

    status, result = await worker_request(
        "DELETE",
        (
            "/api/autothread/config"
            f"?guild_id={interaction.guild.id}"
            f"&channel_id={interaction.channel.id}"
        )
    )

    if status != 200 or not result.get("ok"):
        await interaction.response.send_message(
            "❌ Couldn't disable auto-threading.",
            ephemeral=True
        )
        return

    await interaction.response.send_message(
        "✅ Auto-threading has been disabled for this channel.",
        ephemeral=True
    )


# ============================================================
# /AUTOTHREAD STATUS
# ============================================================

@autothread_group.command(
    name="status",
    description="View the auto-thread settings for this channel."
)
async def autothread_status(
    interaction: discord.Interaction
):

    if interaction.guild is None:
        await interaction.response.send_message(
            "❌ This only works in a server.",
            ephemeral=True
        )
        return

    status, result = await worker_request(
        "GET",
        (
            "/api/autothread/config"
            f"?guild_id={interaction.guild.id}"
            f"&channel_id={interaction.channel.id}"
        )
    )

    if status != 200 or not result.get("ok"):
        await interaction.response.send_message(
            "❌ Couldn't get the auto-thread settings.",
            ephemeral=True
        )
        return

    config = result.get("config")

    if not config or not config.get("enabled"):
        await interaction.response.send_message(
            "ℹ️ Auto-threading is **disabled** in this channel.",
            ephemeral=True
        )
        return

    embed = discord.Embed(
        title="⚡ Auto-thread status",
        color=discord.Color.blurple()
    )

    embed.add_field(
        name="Keyword",
        value=f"`{config['keyword']}`",
        inline=True
    )

    embed.add_field(
        name="Thread name",
        value=f"`{config['thread_name']}`",
        inline=True
    )

    embed.add_field(
        name="Next number",
        value=str(config["counter"]),
        inline=True
    )

    embed.add_field(
        name="Auto archive",
        value=f"{config['auto_archive_duration']} minutes",
        inline=True
    )

    await interaction.response.send_message(
        embed=embed,
        ephemeral=True
    )


# ============================================================
# /AUTOTHREAD RESET
# ============================================================

@autothread_group.command(
    name="reset",
    description="Reset the auto-thread counter."
)
@app_commands.describe(
    number="The number to use for the next matching message."
)
@app_commands.checks.has_permissions(
    manage_threads=True
)
async def autothread_reset(
    interaction: discord.Interaction,
    number: int
):

    if interaction.guild is None:
        await interaction.response.send_message(
            "❌ This only works in a server.",
            ephemeral=True
        )
        return

    if number < 1:
        await interaction.response.send_message(
            "❌ Number must be at least `1`.",
            ephemeral=True
        )
        return

    status, result = await worker_request(
        "POST",
        "/api/autothread/reset",
        {
            "guild_id": str(interaction.guild.id),
            "channel_id": str(interaction.channel.id),
            "counter": number
        }
    )

    if status != 200 or not result.get("ok"):
        await interaction.response.send_message(
            "❌ Couldn't reset the counter.",
            ephemeral=True
        )
        return

    await interaction.response.send_message(
        f"✅ The next auto-thread will be **#{number}**.",
        ephemeral=True
    )


# ============================================================
# PERMISSION ERROR HANDLER
# ============================================================

@bot.tree.error
async def on_app_command_error(
    interaction: discord.Interaction,
    error: app_commands.AppCommandError
):

    if isinstance(
        error,
        app_commands.errors.MissingPermissions
    ):

        if not interaction.response.is_done():
            await interaction.response.send_message(
                "❌ You need the **Manage Threads** permission "
                "to use this command.",
                ephemeral=True
            )

        return

    print(
        f"Slash command error: {error}"
    )

    if not interaction.response.is_done():
        await interaction.response.send_message(
            "❌ Something went wrong while running that command.",
            ephemeral=True
        )


# ============================================================
# START
# ============================================================

if not DISCORD_TOKEN:
    raise RuntimeError(
        "DISCORD_TOKEN environment variable is missing."
    )


bot.run(DISCORD_TOKEN)
