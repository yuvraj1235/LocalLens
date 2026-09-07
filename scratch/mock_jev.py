import httpx2
from typesafe_sdk import TypeSafeClient, Choice, Noul
import json
import sys

original_send = httpx2.Client.send
def mock_send(self, request, *args, **kwargs):
    print("URL:", request.url)
    print("BODY:", request.content.decode('utf-8'))
    sys.exit(0)

httpx2.Client.send = mock_send

client = TypeSafeClient(api_key='sk-or-testkey', base_url='https://openrouter.ai/api')
client.system_one(
    state='test state',
    questions={
        'action': Choice(
            instructions='test',
            criteria={'test1': 'test desc 1', 'test2': 'test desc 2'}
        ),
        'verify': Noul(instructions='is it true?')
    }
)
