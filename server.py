
import os
import httpx
from mcp.server.fastmcp import FastMCP, Image

mcp = FastMCP("灵灵的表情包")

STICKERS = {
    "抱抱": "https://cdn.jsdelivr.net/gh/linmoc39/OpenDroidChat@main/app/src/main/res/drawable/01_%E6%8A%B1%E6%8A%B1.png"
}

@mcp.tool()
async def send_sticker(name: str = "抱抱") -> Image:
    """返回抱抱表情包图片。当前测试版只支持抱抱。"""
    if name not in STICKERS:
        raise ValueError("目前只支持：抱抱")

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(STICKERS[name])
        response.raise_for_status()

        return Image(
            data=response.content,
            mimeType="image/png"
        )

if __name__ == "__main__":
    mcp.run(transport="streamable-http")

