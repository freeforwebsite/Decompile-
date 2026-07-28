import asyncio
import logging

from pyrogram import Client, filters
from pyrogram.types import Message

from config import API_ID, API_HASH, BOT_TOKEN, CHANNEL_ID
from database import movies

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("movie-db-bot")

app = Client(
    "movie-db-bot",
    api_id=API_ID,
    api_hash=API_HASH,
    bot_token=BOT_TOKEN,
)


def extract_media(message: Message):
    """Return (file_id, file_name, caption) for whichever media type the message carries."""
    for attr in ("document", "video", "audio"):
        media = getattr(message, attr, None)
        if media:
            name = getattr(media, "file_name", None) or (message.caption or "untitled")
            return media.file_id, name, message.caption or ""
    return None, None, None


@app.on_message(filters.chat(CHANNEL_ID) & (filters.document | filters.video | filters.audio))
async def index_new_upload(client: Client, message: Message):
    """Whenever a file lands in your channel, record it so it becomes searchable."""
    file_id, file_name, caption = extract_media(message)
    if not file_id:
        return
    await movies.update_one(
        {"message_id": message.id},
        {"$set": {
            "message_id": message.id,
            "chat_id": message.chat.id,
            "file_id": file_id,
            "file_name": file_name,
            "caption": caption,
        }},
        upsert=True,
    )
    log.info("Indexed: %s", file_name)


@app.on_message(filters.private & filters.command("start"))
async def start(client: Client, message: Message):
    await message.reply_text(
        "Send me a title and I'll search the indexed channel for matching files."
    )


@app.on_message(filters.private & filters.text & ~filters.command("start"))
async def search(client: Client, message: Message):
    query = message.text.strip()
    if not query:
        return
    cursor = movies.find(
        {"file_name": {"$regex": query, "$options": "i"}}
    ).limit(10)
    results = await cursor.to_list(length=10)

    if not results:
        await message.reply_text(f"No matches for \u201c{query}\u201d.")
        return

    for doc in results:
        try:
            await client.copy_message(
                chat_id=message.chat.id,
                from_chat_id=doc["chat_id"],
                message_id=doc["message_id"],
            )
        except Exception as e:
            log.warning("Couldn't deliver %s: %s", doc.get("file_name"), e)


async def main():
    await app.start()
    log.info("Movie DB Bot started successfully.")
    await asyncio.Event().wait()  # keep the process alive


if __name__ == "__main__":
    asyncio.run(main())
