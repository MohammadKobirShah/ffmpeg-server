#!/usr/bin/env python3
"""scripts/health_check.py — quick health probe for API + HLS."""
import sys
import requests
from datetime import datetime

API_URL = "http://localhost:3000"
HLS_URL = "http://localhost:8080"


def check_api():
    try:
        r = requests.get(f"{API_URL}/health", timeout=5)
        d = r.json()
        print(f"✅ API: OK | uptime={d['uptime']:.1f}s | active={d['activeStreams']}")
        return True
    except Exception as e:
        print(f"❌ API: FAILED — {e}")
        return False


def check_master(channel_id):
    try:
        url = f"{HLS_URL}/hls/{channel_id}/master.m3u8"
        r = requests.get(url, timeout=5)
        if r.status_code == 200 and "#EXTM3U" in r.text:
            print(f"✅ master.m3u8 {channel_id}: OK")
            return True
        print(f"⚠️  master.m3u8 {channel_id}: HTTP {r.status_code}")
        return False
    except Exception as e:
        print(f"❌ master.m3u8 {channel_id}: {e}")
        return False


def check_segment(channel_id, quality="720p"):
    try:
        url = f"{HLS_URL}/hls/{channel_id}/{quality}/index.m3u8"
        r = requests.get(url, timeout=5)
        if r.status_code != 200:
            print(f"⚠️  {channel_id}/{quality}: playlist HTTP {r.status_code}")
            return False
        ts = [l for l in r.text.splitlines() if l.endswith(".ts")]
        if not ts:
            print(f"⚠️  {channel_id}/{quality}: no segments listed")
            return False
        seg = ts[-1]
        if not seg.startswith("http"):
            seg = f"{HLS_URL}/hls/{channel_id}/{quality}/{seg}"
        h = requests.head(seg, timeout=5)
        size = int(h.headers.get("content-length", 0))
        print(f"✅ segment {channel_id}/{quality}: {size/1024:.1f} KB")
        return True
    except Exception as e:
        print(f"❌ segment {channel_id}/{quality}: {e}")
        return False


if __name__ == "__main__":
    print(f"\n🔍 Health Check — {datetime.now():%Y-%m-%d %H:%M:%S}")
    print("=" * 50)
    check_api()
    for ch in sys.argv[1:]:
        check_master(ch)
        check_segment(ch)
    print("=" * 50)
