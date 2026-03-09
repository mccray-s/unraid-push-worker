# Unraid Push Worker

The official push notification bridge for **[Unraid Deck](https://unraid.mccray.app)**.

## Overview

`unraid-push-worker` is a high-performance, secure relay service designed specifically for the **Unraid Deck** ecosystem. Built on the **Cloudflare Workers** serverless platform, it acts as a critical link between your Unraid server's Webhook system and the **Apple Push Notification service (APNs)**, ensuring system alerts reach your iOS/iPadOS devices instantly.

> [!NOTE]
> **Unraid Deck** is the ultimate native mobile companion for your Unraid server, offering real-time monitoring, Docker & VM management, and interactive widgets.
> 🌐 [Official Website](https://unraid.mccray.app) | 📥 [Download on the App Store](https://apps.apple.com/app/unraid-deck/idXXXXXXXX)

## Why This Bridge?

**Unraid Deck** is built with a **Privacy First** architecture, maintaining a 100% direct connection between your mobile device and your server. However, to bypass iOS background limitations and ensure you receive critical hardware or system alerts (e.g., array errors, drive failures, Docker events) in real-time, this specialized relay service is required.

### Key Benefits:

- **Low Latency**: Leverages Cloudflare's global edge network to ensure notifications are delivered in sub-second time.
- **Security-First**: Built-in support for Admin Secret authentication and Apple's secure Token-based Provider API.
- **Privacy & Control**: Designed to handle sensitive device tokens and server identifiers with strict isolation.
- **Highly Reliable**: Engineered for 99.9% uptime by utilizing Cloudflare's robust serverless infrastructure.
- **Message Analytics**: Integrated Cloudflare KV storage for tracking delivery stats and managing device-to-server relationships.

## Technical Specs

- **Runtime**: Cloudflare Workers (TypeScript)
- **Messaging Protocol**: HTTP/2 APNs Token-based Provider API
- **Storage**: Cloudflare KV (Statistics and metadata management)
- **Authentication**: Bearer Token authentication for administrative and webhook endpoints
