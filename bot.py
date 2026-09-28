import os
import logging
from datetime import datetime, timezone

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands


# ============================================================
# CONFIG
# ============================================================

TOKEN = os.getenv("DISCORD_TOKEN")

# Change this to your actual Cloudflare Worker URL.
WORKER_URL = os.getenv(
    "THREAD_API_URL",
    "https://thread-api.yeeter.workers.dev"
)


# ============================================================
# LOGGING
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)


# ============================================================
# BOT
# ============================================================

class ThreadBot(commands.Bot):

    def __init__(self):
        intents = discord.Intents.default()

        super().__init__(
            command_prefix="!",
            intents=intents
        )

    async def setup_hook(self):
        await self.tree.sync()

        logging.info(
            "Slash commands synced successfully."
        )


bot = ThreadBot()


# ============================================================
# WORKER API
# ============================================================

async def worker_request(
    method: str,
    endpoint: str,
    data: dict | None = None
):
    """
    Sends information to the Cloudflare Worker.

    The bot still works if the Worker is temporarily
    unavailable, so API problems don't kill the bot.
    """

    url = f"{WORKER_URL.rstrip('/')}{endpoint}"

    try:
        timeout = aiohttp.ClientTimeout(total=5)

        async with aiohttp.ClientSession(
            timeout=timeout
        ) as session:

            async with session.request(
                method,
                url,
                json=data
            ) as response:

                return response.status

    except Exception as error:

        logging.warning(
            "Worker request failed: %s",
            error
        )

        return None


# ============================================================
# READY
# ============================================================

@bot.event
async def on_ready():

    logging.info(
        "Logged in as %s",
        bot.user
    )

    logging.info(
        "Connected to %s server(s)",
        len(bot.guilds)
    )

    await worker_request(
        "POST",
        "/api/events",
        {
            "event": "bot_ready",
            "guilds": len(bot.guilds),
            "timestamp": datetime.now(
                timezone.utc
            ).isoformat()
        }
    )


# ============================================================
# /THREAD GROUP
# ============================================================

thread_group = app_commands.Group(
    name="thread",
    description="Create and manage Discord threads."
)


# ============================================================
# /THREAD CREATE
# ============================================================

@thread_group.command(
    name="create",
    description="Create a new thread."
)
@app_commands.describe(
    name="The name of the new thread."
)
async def thread_create(
    interaction: discord.Interaction,
    name: str
):

    channel = interaction.channel

    if not isinstance(
        channel,
        discord.TextChannel
    ):

        await interaction.response.send_message(
            "❌ This command must be used in a text channel.",
            ephemeral=True
        )

        return

    await interaction.response.defer(
        ephemeral=True
    )

    try:

        new_thread = await channel.create_thread(
            name=name,
            type=discord.ChannelType.public_thread,
            auto_archive_duration=1440,
            reason=(
                f"Created by "
                f"{interaction.user} "
                f"using /thread create"
            )
        )

        await worker_request(
            "POST",
            "/api/events",
            {
                "event": "thread_created",
                "guild_id": interaction.guild_id,
                "channel_id": channel.id,
                "thread_id": new_thread.id
            }
        )

        await interaction.followup.send(
            f"🧵 Created {new_thread.mention}\n\n"
            "Use `/thread manage` inside the thread "
            "to open the management panel.",
            ephemeral=True
        )

    except discord.Forbidden:

        await interaction.followup.send(
            "❌ I don't have permission to create "
            "public threads in this channel.",
            ephemeral=True
        )

    except discord.HTTPException as error:

        await interaction.followup.send(
            f"❌ Discord returned an error:\n"
            f"`{error}`",
            ephemeral=True
        )


# ============================================================
# RENAME MODAL
# ============================================================

class RenameThreadModal(
    discord.ui.Modal,
    title="Rename Thread"
):

    new_name = discord.ui.TextInput(
        label="New thread name",
        placeholder="Enter the new name...",
        min_length=1,
        max_length=100,
        required=True
    )

    async def on_submit(
        self,
        interaction: discord.Interaction
    ):

        thread = interaction.channel

        if not isinstance(
            thread,
            discord.Thread
        ):

            await interaction.response.send_message(
                "❌ This isn't a thread.",
                ephemeral=True
            )

            return

        old_name = thread.name

        try:

            await thread.edit(
                name=str(self.new_name.value)
            )

            await interaction.response.send_message(
                f"✏️ Renamed **{old_name}** "
                f"to **{thread.name}**."
            )

        except discord.Forbidden:

            await interaction.response.send_message(
                "❌ I don't have permission "
                "to rename this thread.",
                ephemeral=True
            )


# ============================================================
# DELETE CONFIRMATION
# ============================================================

class DeleteConfirmView(
    discord.ui.View
):

    def __init__(self):

        super().__init__(
            timeout=30
        )

    @discord.ui.button(
        label="Delete",
        emoji="🗑️",
        style=discord.ButtonStyle.danger
    )
    async def confirm_delete(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button
    ):

        thread = interaction.channel

        if not isinstance(
            thread,
            discord.Thread
        ):

            await interaction.response.edit_message(
                content="❌ This isn't a thread.",
                view=None
            )

            return

        await interaction.response.edit_message(
            content="🗑️ Deleting thread...",
            view=None
        )

        try:

            await thread.delete(
                reason=(
                    f"Deleted by "
                    f"{interaction.user} "
                    f"through Thread manager"
                )
            )

        except discord.Forbidden:

            await interaction.followup.send(
                "❌ I don't have permission "
                "to delete this thread.",
                ephemeral=True
            )

    @discord.ui.button(
        label="Cancel",
        emoji="✖️",
        style=discord.ButtonStyle.secondary
    )
    async def cancel_delete(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button
    ):

        await interaction.response.edit_message(
            content="Cancelled.",
            view=None
        )


# ============================================================
# THREAD MANAGER
# ============================================================

class ThreadManageView(
    discord.ui.View
):

    def __init__(self):

        super().__init__(
            timeout=300
        )

    # --------------------------------------------------------
    # RENAME
    # --------------------------------------------------------

    @discord.ui.button(
        label="Rename",
        emoji="✏️",
        style=discord.ButtonStyle.primary
    )
    async def rename(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button
    ):

        if not isinstance(
            interaction.channel,
            discord.Thread
        ):

            await interaction.response.send_message(
                "❌ Use this inside a thread.",
                ephemeral=True
            )

            return

        await interaction.response.send_modal(
            RenameThreadModal()
        )

    # --------------------------------------------------------
    # INFO
    # --------------------------------------------------------

    @discord.ui.button(
        label="Info",
        emoji="ℹ️",
        style=discord.ButtonStyle.secondary
    )
    async def info(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button
    ):

        thread = interaction.channel

        if not isinstance(
            thread,
            discord.Thread
        ):

            await interaction.response.send_message(
                "❌ Use this inside a thread.",
                ephemeral=True
            )

            return

        embed = discord.Embed(
            title="🧵 Thread Information",
            color=discord.Color.blurple()
        )

        owner = thread.owner

        embed.add_field(
            name="Name",
            value=thread.name,
            inline=False
        )

        embed.add_field(
            name="Thread ID",
            value=str(thread.id),
            inline=True
        )

        embed.add_field(
            name="Messages",
            value=str(
                thread.message_count or 0
            ),
            inline=True
        )

        embed.add_field(
            name="Members",
            value=str(
                thread.member_count or 0
            ),
            inline=True
        )

        embed.add_field(
            name="Archived",
            value=(
                "Yes"
                if thread.archived
                else "No"
            ),
            inline=True
        )

        embed.add_field(
            name="Locked",
            value=(
                "Yes"
                if thread.locked
                else "No"
            ),
            inline=True
        )

        if owner:

            embed.add_field(
                name="Owner",
                value=owner.mention,
                inline=True
            )

        await interaction.response.send_message(
            embed=embed,
            ephemeral=True
        )

    # --------------------------------------------------------
    # ARCHIVE
    # --------------------------------------------------------

    @discord.ui.button(
        label="Archive",
        emoji="📦",
        style=discord.ButtonStyle.secondary
    )
    async def archive(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button
    ):

        thread = interaction.channel

        if not isinstance(
            thread,
            discord.Thread
        ):

            await interaction.response.send_message(
                "❌ Use this inside a thread.",
                ephemeral=True
            )

            return

        try:

            await thread.edit(
                archived=True
            )

            await interaction.response.send_message(
                "📦 Thread archived."
            )

        except discord.Forbidden:

            await interaction.response.send_message(
                "❌ I can't archive this thread.",
                ephemeral=True
            )

    # --------------------------------------------------------
    # LOCK
    # --------------------------------------------------------

    @discord.ui.button(
        label="Lock",
        emoji="🔒",
        style=discord.ButtonStyle.secondary
    )
    async def lock(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button
    ):

        thread = interaction.channel

        if not isinstance(
            thread,
            discord.Thread
        ):

            await interaction.response.send_message(
                "❌ Use this inside a thread.",
                ephemeral=True
            )

            return

        try:

            await thread.edit(
                locked=True
            )

            await interaction.response.send_message(
                "🔒 Thread locked."
            )

        except discord.Forbidden:

            await interaction.response.send_message(
                "❌ I can't lock this thread.",
                ephemeral=True
            )

    # --------------------------------------------------------
    # DELETE
    # --------------------------------------------------------

    @discord.ui.button(
        label="Delete",
        emoji="🗑️",
        style=discord.ButtonStyle.danger
    )
    async def delete(
        self,
        interaction: discord.Interaction,
        button: discord.ui.Button
    ):

        await interaction.response.send_message(
            "⚠️ **Are you sure you want to "
            "permanently delete this thread?**",
            view=DeleteConfirmView(),
            ephemeral=True
        )


# ============================================================
# /THREAD MANAGE
# ============================================================

@thread_group.command(
    name="manage",
    description="Open the thread management panel."
)
async def thread_manage(
    interaction: discord.Interaction
):

    if not isinstance(
        interaction.channel,
        discord.Thread
    ):

        await interaction.response.send_message(
            "❌ Use `/thread manage` inside a thread.",
            ephemeral=True
        )

        return

    thread = interaction.channel

    embed = discord.Embed(
        title="🧵 Thread Manager",
        description=(
            f"Managing **{thread.name}**\n\n"
            "Choose an action below."
        ),
        color=discord.Color.blurple()
    )

    await interaction.response.send_message(
        embed=embed,
        view=ThreadManageView(),
        ephemeral=True
    )


# Register the /thread command group.
bot.tree.add_command(
    thread_group
)


# ============================================================
# START
# ============================================================

if __name__ == "__main__":

    if not TOKEN:

        raise RuntimeError(
            "DISCORD_TOKEN is not set."
        )

    bot.run(TOKEN)
