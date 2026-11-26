#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Jarvis haber toplayıcı: Google Haberler RSS'inden spor ve siyaset başlıklarını
toplayıp news.json dosyasına yazar. GitHub Actions saatte bir çalıştırır."""
import json, re, sys, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

TR = 'hl=tr&gl=TR&ceid=TR:tr'
FEEDS = {
    'spor': [f'https://news.google.com/rss/headlines/section/topic/SPORTS?{TR}'],
    'siyaset': [
        f'https://news.google.com/rss/search?q=siyaset%20OR%20TBMM%20OR%20bakan%20OR%20se%C3%A7im%20when:1d&{TR}',
        f'https://news.google.com/rss/headlines/section/topic/WORLD?{TR}',
    ],
}
PER = 12


def parse(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = []
    for it in root.iter('item'):
        title = (it.findtext('title') or '').strip()
        src = (it.findtext('source') or '').strip()
        if src and title.endswith(' - ' + src):
            title = title[: -len(src) - 3].strip()
        try:
            dt = parsedate_to_datetime(it.findtext('pubDate')).astimezone(timezone.utc)
        except Exception:
            dt = datetime.now(timezone.utc)
        out.append({'title': title, 'source': src, 'link': it.findtext('link') or '', 'time': dt.isoformat()})
    return out


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 JarvisNews/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def norm(t):
    return re.sub(r'\W+', ' ', t.lower()).strip()[:60]


def main(out_path='news.json'):
    result = {'updated': datetime.now(timezone.utc).isoformat()}
    for cat, urls in FEEDS.items():
        items, seen = [], set()
        for u in urls:
            try:
                got = parse(fetch(u))
            except Exception as e:
                print(f'{cat}: {u} alınamadı: {e}', file=sys.stderr)
                continue
            for x in got:
                k = norm(x['title'])
                if k and k not in seen:
                    seen.add(k); items.append(x)
        items.sort(key=lambda x: x['time'], reverse=True)
        result[cat] = items[:PER]
        print(f'{cat}: {len(result[cat])} başlık')
    if not any(result.get(c) for c in FEEDS):
        sys.exit('Hiç haber alınamadı; eski news.json korunuyor.')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main(*sys.argv[1:])
