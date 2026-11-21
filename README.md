# Pitlane Garage Management

Pitlane runs a workshop and its spare-parts counter in one application. It uses React, Tailwind CSS, Express, TypeORM, and PostgreSQL. Express serves both the frontend and the API on the same origin.

## Run locally

1. Install Node.js 22.12 or later and PostgreSQL. Create a database and a PostgreSQL login that can create objects in that database.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL`, `ADMIN_EMAIL`, and a strong `ADMIN_PASSWORD` of at least 12 characters. Choose `GARAGE_CURRENCY` and `GARAGE_TIMEZONE` before setup. The defaults are KES and Africa/Nairobi.
3. From the project directory, run:

   ```sh
   npm ci
   npm run db:setup
   npm run dev
   ```

4. Open [the local app](http://127.0.0.1:5173) and sign in with the configured administrator. Add staff accounts in **Team & permissions**.

The setup command can also add the session table to an existing installation of the Step 1 schema. It preserves existing users and settings. Use **Team & permissions** to change an existing account password.

## Roles and workflows

| Role | Workflow |
|---|---|
| Administrator | Register customers and vehicles, open and assign job cards, manage staff access, review feedback, inspect analytics, and override a draft line price with a recorded reason. Can also perform every staff workflow. |
| Mechanic | Open assigned job cards, start and complete work, log notes and labor, and request or cancel pending parts requests. |
| Shop manager | Manage parts and suppliers, record stock deliveries and adjustments, review low-stock alerts, fulfill requests, and issue walk-in sales from the counter. |
| Accountant | Create invoices for completed jobs, record and review service and counter-sale payments, print invoices and receipts, and view financial reports. |

Stock is deducted when a mechanic's request is fulfilled or a walk-in sale is issued. Pending parts requests must be resolved before a job is completed. A service invoice copies the completed job's labor charges and fulfilled parts. Issued invoices retain their prices and customer billing details.

Payment methods include cash, card, bank transfer, and mobile money. A cashier records transactions handled through the chosen payment channel and confirms them in Pitlane. Confirmed payments reduce the balance and produce a printable receipt. Reports use confirmed payment dates in the configured time zone. Low-stock alerts appear in the dashboard and inventory.

## Production

Run `npm ci`, `npm run db:setup`, and `npm run build`. Serve `npm start` behind an HTTPS reverse proxy with `NODE_ENV=production` and `APP_ORIGIN` set to the public HTTPS origin. Set `TRUST_PROXY_HOPS` to match your trusted proxy chain if the proxy forwards client IPs for the sign-in rate limiter. The database should be reachable by the Node server. Session cookies use HTTP-only and SameSite protections, and production cookies also require HTTPS. The database stores hashed session tokens and bcrypt password hashes.

### Deploy on Render

Open [Deploy to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fralph4112%2Fpitlane) and sign in to Render. Set `ADMIN_EMAIL` and a new `ADMIN_PASSWORD` of at least 12 characters when prompted, then approve the Blueprint. Use the web service's HTTPS URL and those credentials to sign in.

The [Blueprint](render.yaml) provisions a web service and a new PostgreSQL database reachable on Render's private network. Render supplies the public HTTPS URL and database connection string. On each start the service checks the schema and initializes missing records while preserving existing accounts. Set `APP_ORIGIN` to your HTTPS origin if you later switch to a custom domain.

The Blueprint uses free plans for a trial deployment. Render's free PostgreSQL databases expire after 30 days. Choose a persistent paid database before storing live garage records. [Render free-plan limits](https://render.com/docs/free)

The SQL migrations are [schema.sql](db/schema.sql) and [sessions.sql](db/sessions.sql). Database triggers protect stock balances, invoice snapshots, and payment totals. API validators require typed, explicitly allowed fields. Backend permissions are checked on every protected request.

## Verify

`npm run build` compiles the frontend. To run the integration test, first initialize a disposable PostgreSQL database with `npm run db:setup`. Then set `TEST_DATABASE_URL` to that database's URL and run `npm test`. The test creates unique fixture records and exercises sign-in, route and record authorization, stock fulfillment and checkout, billing, concurrent payment confirmation, feedback, and reports.

The API is under `/api`. Main collections include `/jobs`, `/customers`, `/vehicles`, `/parts`, `/suppliers`, `/parts-requests`, `/invoices`, `/feedback`, and `/users`. Reporting uses `/analytics` and `/reports/finance`.
