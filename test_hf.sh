#!/bin/bash
read -p "Enter your Hugging Face Token: " TOKEN
echo "Testing token..."
curl -s -X POST \
  "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputs": "Hello, world!"}' | jq .
if [ $? -eq 0 ]; then
  echo -e "\nCommand finished."
fi
