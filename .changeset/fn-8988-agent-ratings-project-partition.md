---
"@runfusion/fusion": patch
---

summary: Agent ratings are now isolated per project on shared PostgreSQL databases.
category: fix
dev: Migration 0055 and SCHEMA_BASELINE_VERSION protect the composite partition; addRating/getRatings/deleteRating use bound project scope.
