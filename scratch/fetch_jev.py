import requests
from bs4 import BeautifulSoup
import json

url = "https://openrouter.ai/models/typesafe/jev-latest"
res = requests.get(url)
soup = BeautifulSoup(res.text, "html.parser")
for script in soup.find_all("script", type="application/json"):
    print(script.text[:1000])
print("---- TEXT ----")
print(soup.get_text(separator="\n", strip=True)[:3000])
