// Captured from https://openrouter.ai/api/v1/models on 2026-10-03 (public, no auth).
export const bunnyCatalog = {
  "data": [
    {
      "id": "stealth/space-bunny-alpha",
      "name": "Space Bunny Alpha",
      "context_length": 1000000,
      "architecture": {
        "modality": "text+image+video->text",
        "input_modalities": [
          "text",
          "image",
          "video"
        ],
        "output_modalities": [
          "text"
        ],
        "tokenizer": "Other",
        "instruct_type": null
      },
      "pricing": {
        "prompt": "0",
        "completion": "0"
      },
      "top_provider": {
        "context_length": 1000000,
        "max_completion_tokens": 524288,
        "is_moderated": false
      },
      "supported_parameters": [
        "include_reasoning",
        "max_tokens",
        "reasoning",
        "reasoning_effort",
        "response_format",
        "temperature",
        "tool_choice",
        "tools",
        "top_p"
      ],
      "reasoning": {
        "mandatory": true,
        "supported_efforts": [
          "max",
          "xhigh",
          "high",
          "medium",
          "low"
        ],
        "default_effort": "max"
      }
    }
  ]
};
