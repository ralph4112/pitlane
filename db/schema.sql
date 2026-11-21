BEGIN;

CREATE SCHEMA garage;
SET LOCAL search_path = garage, pg_catalog;

CREATE TYPE job_status AS ENUM ('pending', 'in_progress', 'completed');
CREATE TYPE request_status AS ENUM ('pending', 'fulfilled', 'rejected', 'cancelled');
CREATE TYPE invoice_kind AS ENUM ('service', 'shop_sale');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'bank_transfer', 'mobile_money');
CREATE TYPE payment_status AS ENUM ('pending', 'confirmed', 'failed');
CREATE TYPE feedback_status AS ENUM ('open', 'in_review', 'resolved');

CREATE DOMAIN currency_code AS text CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN unit_price AS numeric(14, 2)
    CHECK (VALUE >= 0 AND VALUE < 'Infinity'::numeric);

-- The installation uses a single currency. Set this before entering business data.
CREATE TABLE business_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    currency currency_code NOT NULL,
    reporting_timezone text NOT NULL
);

CREATE TABLE roles (
    code text PRIMARY KEY,
    name text NOT NULL UNIQUE
);

INSERT INTO roles (code, name) VALUES
    ('admin', 'Admin'),
    ('mechanic', 'Mechanic'),
    ('shop_manager', 'Shop Manager'),
    ('accountant', 'Accountant');

CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_code text NOT NULL REFERENCES roles (code),
    full_name text NOT NULL CHECK (btrim(full_name) <> ''),
    email text NOT NULL CHECK (email <> '' AND email = btrim(email)),
    password_hash text NOT NULL CHECK (btrim(password_hash) <> ''),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE customers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name text NOT NULL CHECK (btrim(full_name) <> ''),
    phone text,
    email text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES customers,
    registration_number text NOT NULL CHECK (btrim(registration_number) <> ''),
    vin text CHECK (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
    make text NOT NULL CHECK (btrim(make) <> ''),
    model text NOT NULL CHECK (btrim(model) <> ''),
    model_year smallint CHECK (model_year >= 1886),
    UNIQUE (vin)
);

CREATE UNIQUE INDEX vehicles_registration_unique
    ON vehicles (upper(btrim(registration_number)));
CREATE INDEX vehicles_customer_idx ON vehicles (customer_id);

CREATE TABLE jobs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id bigint NOT NULL REFERENCES vehicles,
    customer_id bigint NOT NULL REFERENCES customers,
    created_by bigint NOT NULL REFERENCES users,
    mechanic_id bigint REFERENCES users,
    status job_status NOT NULL DEFAULT 'pending',
    description text NOT NULL CHECK (btrim(description) <> ''),
    odometer_km integer CHECK (odometer_km >= 0),
    opened_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    status_changed_by bigint NOT NULL REFERENCES users,
    revision bigint NOT NULL DEFAULT 0,
    CHECK (status = 'pending' OR mechanic_id IS NOT NULL),
    CHECK (
        (status = 'pending' AND started_at IS NULL AND completed_at IS NULL)
        OR (status = 'in_progress' AND started_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CHECK (started_at >= opened_at AND completed_at >= started_at)
);

CREATE INDEX jobs_mechanic_status_idx ON jobs (mechanic_id, status);
CREATE INDEX jobs_vehicle_history_idx ON jobs (vehicle_id, opened_at DESC);
CREATE INDEX jobs_completed_idx ON jobs (completed_at) WHERE status = 'completed';

CREATE TABLE job_status_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id bigint NOT NULL REFERENCES jobs,
    status job_status NOT NULL,
    changed_by bigint NOT NULL REFERENCES users,
    changed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, status)
);

CREATE TABLE service_notes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id bigint NOT NULL REFERENCES jobs,
    author_id bigint NOT NULL REFERENCES users,
    body text NOT NULL CHECK (btrim(body) <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX service_notes_job_idx ON service_notes (job_id, created_at);

CREATE TABLE job_labor (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id bigint NOT NULL REFERENCES jobs,
    description text NOT NULL CHECK (btrim(description) <> ''),
    amount unit_price NOT NULL,
    recorded_by bigint NOT NULL REFERENCES users,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_labor_job_idx ON job_labor (job_id);

CREATE TABLE suppliers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL CHECK (btrim(name) <> ''),
    contact_name text,
    email text,
    phone text,
    address text
);

CREATE TABLE parts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku text NOT NULL CHECK (btrim(sku) <> ''),
    name text NOT NULL CHECK (btrim(name) <> ''),
    description text,
    supplier_id bigint REFERENCES suppliers,
    unit_cost unit_price NOT NULL,
    unit_price unit_price NOT NULL,
    -- Initialize at zero and record all receipts and adjustments in stock_movements.
    stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    reorder_threshold integer NOT NULL DEFAULT 0 CHECK (reorder_threshold >= 0),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX parts_sku_unique ON parts (upper(btrim(sku)));
CREATE INDEX parts_supplier_idx ON parts (supplier_id);

CREATE TABLE part_requests (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id bigint NOT NULL REFERENCES jobs,
    part_id bigint NOT NULL REFERENCES parts,
    quantity integer NOT NULL CHECK (quantity > 0),
    requested_by bigint NOT NULL REFERENCES users,
    requested_at timestamptz NOT NULL DEFAULT now(),
    status request_status NOT NULL DEFAULT 'pending',
    resolved_by bigint REFERENCES users,
    resolved_at timestamptz,
    fulfilled_unit_price unit_price,
    CHECK (
        (status = 'pending' AND resolved_by IS NULL AND resolved_at IS NULL)
        OR (status <> 'pending' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    ),
    CHECK ((status = 'fulfilled') = (fulfilled_unit_price IS NOT NULL))
);

CREATE INDEX part_requests_job_idx ON part_requests (job_id);
CREATE INDEX part_requests_queue_idx ON part_requests (requested_at) WHERE status = 'pending';

-- An invoice starts as a draft. Issue it by setting issued_by.
CREATE TABLE invoices (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind invoice_kind NOT NULL,
    job_id bigint UNIQUE REFERENCES jobs,
    customer_id bigint REFERENCES customers,
    bill_to_name text CHECK (btrim(bill_to_name) <> ''),
    bill_to_contact text,
    currency currency_code NOT NULL,
    created_by bigint NOT NULL REFERENCES users,
    created_at timestamptz NOT NULL DEFAULT now(),
    issued_by bigint REFERENCES users,
    issued_at timestamptz,
    revision bigint NOT NULL DEFAULT 0,
    CHECK ((kind = 'service') = (job_id IS NOT NULL)),
    CHECK (kind <> 'service' OR customer_id IS NOT NULL),
    CHECK ((issued_by IS NULL) = (issued_at IS NULL))
);

CREATE TABLE invoice_lines (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id bigint NOT NULL REFERENCES invoices,
    labor_id bigint UNIQUE REFERENCES job_labor,
    part_request_id bigint UNIQUE REFERENCES part_requests,
    part_id bigint REFERENCES parts,
    description text NOT NULL CHECK (btrim(description) <> ''),
    quantity integer NOT NULL CHECK (quantity > 0),
    base_unit_price unit_price NOT NULL,
    override_unit_price unit_price,
    overridden_by bigint REFERENCES users,
    override_reason text CHECK (btrim(override_reason) <> ''),
    line_total numeric(24, 2) GENERATED ALWAYS AS
        (quantity * coalesce(override_unit_price, base_unit_price)) STORED,
    CHECK ((labor_id IS NULL) <> (part_id IS NULL)),
    CHECK (labor_id IS NULL OR (quantity = 1 AND part_request_id IS NULL)),
    CHECK (part_request_id IS NULL OR part_id IS NOT NULL),
    CHECK ((override_unit_price IS NULL) = (overridden_by IS NULL)),
    CHECK ((override_unit_price IS NULL) = (override_reason IS NULL))
);

CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);
CREATE INDEX invoice_lines_part_idx ON invoice_lines (part_id) WHERE part_id IS NOT NULL;

CREATE TABLE stock_movements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    part_id bigint NOT NULL REFERENCES parts,
    quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
    part_request_id bigint UNIQUE REFERENCES part_requests,
    invoice_line_id bigint UNIQUE REFERENCES invoice_lines,
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    recorded_by bigint NOT NULL REFERENCES users,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(part_request_id, invoice_line_id) <= 1),
    CHECK ((part_request_id IS NULL AND invoice_line_id IS NULL) OR quantity_delta < 0)
);

CREATE INDEX stock_movements_part_idx ON stock_movements (part_id, recorded_at);

CREATE TABLE payments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id bigint NOT NULL REFERENCES invoices,
    amount unit_price NOT NULL CHECK (amount > 0),
    method payment_method NOT NULL,
    status payment_status NOT NULL DEFAULT 'pending',
    idempotency_key uuid NOT NULL UNIQUE,
    external_reference text CHECK (btrim(external_reference) <> ''),
    recorded_by bigint NOT NULL REFERENCES users,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    reviewed_by bigint REFERENCES users,
    reviewed_at timestamptz,
    CHECK (
        (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

CREATE INDEX payments_invoice_idx ON payments (invoice_id);
CREATE INDEX payments_confirmed_idx ON payments (reviewed_at) WHERE status = 'confirmed';

CREATE TABLE feedback (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id bigint NOT NULL REFERENCES jobs,
    rating smallint CHECK (rating BETWEEN 1 AND 5),
    comments text CHECK (btrim(comments) <> ''),
    is_complaint boolean NOT NULL DEFAULT false,
    status feedback_status NOT NULL DEFAULT 'open',
    logged_by bigint NOT NULL REFERENCES users,
    logged_at timestamptz NOT NULL DEFAULT now(),
    resolved_by bigint REFERENCES users,
    resolved_at timestamptz,
    resolution_notes text CHECK (btrim(resolution_notes) <> ''),
    CHECK (rating IS NOT NULL OR comments IS NOT NULL),
    CHECK (NOT is_complaint OR comments IS NOT NULL),
    CHECK (
        (status = 'resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
            AND resolution_notes IS NOT NULL)
        OR (status <> 'resolved' AND resolved_by IS NULL AND resolved_at IS NULL
            AND resolution_notes IS NULL)
    )
);

CREATE INDEX feedback_job_idx ON feedback (job_id);
CREATE INDEX feedback_complaints_idx ON feedback (status, logged_at) WHERE is_complaint;

CREATE FUNCTION guard_business_settings() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Business settings cannot be deleted';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'The operating currency is fixed after setup';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.reporting_timezone) THEN
        RAISE EXCEPTION 'Unknown reporting time zone: %', NEW.reporting_timezone;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER business_settings_guard
BEFORE INSERT OR UPDATE OR DELETE ON business_settings
FOR EACH ROW EXECUTE FUNCTION guard_business_settings();

CREATE FUNCTION guard_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION 'New jobs must start pending';
        END IF;
        NEW.status_changed_by := NEW.created_by;
    ELSE
        IF OLD.status = 'completed' THEN
            RAISE EXCEPTION 'Completed job cards are immutable';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            IF OLD.status = 'pending' AND NEW.status = 'in_progress' THEN
                NEW.started_at := clock_timestamp();
            ELSIF OLD.status = 'in_progress' AND NEW.status = 'completed' THEN
                IF EXISTS (SELECT 1 FROM part_requests WHERE job_id = OLD.id AND status = 'pending') THEN
                    RAISE EXCEPTION 'Resolve pending parts requests before completing a job';
                END IF;
                NEW.started_at := OLD.started_at;
                NEW.completed_at := clock_timestamp();
            ELSE
                RAISE EXCEPTION 'Invalid job status transition';
            END IF;
        ELSE
            NEW.started_at := OLD.started_at;
            NEW.completed_at := OLD.completed_at;
            NEW.status_changed_by := OLD.status_changed_by;
        END IF;
    END IF;

    IF NEW.mechanic_id IS NOT NULL AND
       (TG_OP = 'INSERT' OR NEW.mechanic_id IS DISTINCT FROM OLD.mechanic_id) THEN
        IF NOT EXISTS (
            SELECT 1 FROM users
            WHERE id = NEW.mechanic_id AND role_code = 'mechanic' AND is_active
            FOR SHARE
        ) THEN
            RAISE EXCEPTION 'Assign an active mechanic to the job';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_guard BEFORE INSERT OR UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION guard_job();

CREATE FUNCTION log_job_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO job_status_history (job_id, status, changed_by, changed_at)
        VALUES (NEW.id, NEW.status, NEW.status_changed_by,
                coalesce(NEW.completed_at, NEW.started_at, NEW.opened_at));
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_status_history AFTER INSERT OR UPDATE OF status ON jobs
FOR EACH ROW EXECUTE FUNCTION log_job_status();

-- Advance the parent row so completion and child writes also conflict at higher isolation levels.
CREATE FUNCTION touch_open_job(target_job_id bigint) RETURNS void
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    UPDATE jobs SET revision = revision + 1 WHERE id = target_job_id AND status <> 'completed';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job % must be open', target_job_id;
    END IF;
END;
$$;

CREATE FUNCTION guard_job_labor() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM touch_open_job(OLD.job_id);
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.job_id <> OLD.job_id THEN
        RAISE EXCEPTION 'Labor cannot be moved to another job';
    END IF;
    PERFORM touch_open_job(NEW.job_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER job_labor_guard BEFORE INSERT OR UPDATE OR DELETE ON job_labor
FOR EACH ROW EXECUTE FUNCTION guard_job_labor();

CREATE FUNCTION guard_part_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    PERFORM touch_open_job(NEW.job_id);
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION 'New parts requests must start pending';
        END IF;
    ELSE
        IF OLD.status <> 'pending' THEN
            RAISE EXCEPTION 'Resolved parts requests are immutable';
        END IF;
        IF (NEW.job_id, NEW.part_id, NEW.quantity, NEW.requested_by, NEW.requested_at)
            IS DISTINCT FROM (OLD.job_id, OLD.part_id, OLD.quantity, OLD.requested_by, OLD.requested_at) THEN
            RAISE EXCEPTION 'Cancel and replace a request to change its details';
        END IF;
        IF NEW.status <> 'pending' THEN
            NEW.resolved_at := clock_timestamp();
        END IF;
        IF NEW.status = 'fulfilled' THEN
            SELECT unit_price INTO NEW.fulfilled_unit_price
            FROM parts WHERE id = NEW.part_id AND is_active FOR NO KEY UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Only active parts can be fulfilled';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '% records are append-only for this operation', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER part_requests_guard BEFORE INSERT OR UPDATE ON part_requests
FOR EACH ROW EXECUTE FUNCTION guard_part_request();
CREATE TRIGGER part_requests_no_delete BEFORE DELETE ON part_requests
FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER job_status_history_immutable BEFORE UPDATE OR DELETE ON job_status_history
FOR EACH ROW EXECUTE FUNCTION reject_change();

CREATE FUNCTION apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    IF NEW.part_request_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM part_requests r
        WHERE r.id = NEW.part_request_id AND r.part_id = NEW.part_id
            AND r.status = 'fulfilled' AND r.quantity = -NEW.quantity_delta::bigint
    ) THEN
        RAISE EXCEPTION 'Invalid stock movement for parts request';
    END IF;
    IF NEW.invoice_line_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
        WHERE l.id = NEW.invoice_line_id AND l.part_id = NEW.part_id
            AND i.kind = 'shop_sale' AND i.issued_at IS NOT NULL
            AND l.quantity = -NEW.quantity_delta::bigint
    ) THEN
        RAISE EXCEPTION 'Invalid stock movement for shop sale';
    END IF;

    UPDATE parts SET stock_quantity = stock_quantity + NEW.quantity_delta
    WHERE id = NEW.part_id AND stock_quantity::bigint + NEW.quantity_delta >= 0
        AND (is_active OR num_nonnulls(NEW.part_request_id, NEW.invoice_line_id) = 0);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient stock or unavailable part %', NEW.part_id;
    END IF;
    RETURN NEW;
END;
$$;

-- AFTER INSERT also keeps ON CONFLICT DO NOTHING from applying a skipped movement.
CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW EXECUTE FUNCTION reject_change();

CREATE FUNCTION deduct_fulfilled_parts() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    INSERT INTO stock_movements (part_id, quantity_delta, part_request_id, reason, recorded_by)
    VALUES (NEW.part_id, -NEW.quantity, NEW.id, 'Service parts fulfillment', NEW.resolved_by);
    RETURN NEW;
END;
$$;

CREATE TRIGGER part_requests_deduct AFTER UPDATE OF status ON part_requests
FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status = 'fulfilled')
EXECUTE FUNCTION deduct_fulfilled_parts();

CREATE FUNCTION guard_invoice_line() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
DECLARE
    target_invoice_id bigint;
    sale_kind invoice_kind;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_invoice_id := OLD.invoice_id;
    ELSE
        target_invoice_id := NEW.invoice_id;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.invoice_id <> OLD.invoice_id THEN
        RAISE EXCEPTION 'Invoice lines cannot be moved to another invoice';
    END IF;

    UPDATE invoices SET revision = revision + 1
    WHERE id = target_invoice_id AND issued_at IS NULL RETURNING kind INTO sale_kind;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice lines require a draft invoice';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    IF sale_kind = 'shop_sale' THEN
        IF NEW.part_id IS NULL OR NEW.part_request_id IS NOT NULL THEN
            RAISE EXCEPTION 'Shop invoices only accept standalone part lines';
        END IF;
        IF TG_OP = 'INSERT' OR NEW.part_id IS DISTINCT FROM OLD.part_id THEN
            SELECT unit_price INTO NEW.base_unit_price
                FROM parts WHERE id = NEW.part_id AND is_active;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Only active parts can be added to shop sales';
            END IF;
        ELSE
            NEW.base_unit_price := OLD.base_unit_price;
        END IF;
    END IF;
    IF NEW.overridden_by IS NOT NULL AND (
        TG_OP = 'INSERT' OR (NEW.override_unit_price, NEW.overridden_by, NEW.override_reason)
            IS DISTINCT FROM (OLD.override_unit_price, OLD.overridden_by, OLD.override_reason)
    ) AND NOT EXISTS (
        SELECT 1 FROM users WHERE id = NEW.overridden_by AND role_code = 'admin' AND is_active
        FOR SHARE
    ) THEN
        RAISE EXCEPTION 'Price overrides require an active admin';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
FOR EACH ROW EXECUTE FUNCTION guard_invoice_line();

CREATE FUNCTION guard_invoice() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
DECLARE
    operating_currency currency_code;
    invoice_job jobs%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.issued_at IS NOT NULL THEN
            RAISE EXCEPTION 'Issued invoices are immutable';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.issued_by IS NOT NULL OR NEW.issued_at IS NOT NULL THEN
            RAISE EXCEPTION 'Create invoice lines before issuing an invoice';
        END IF;
        SELECT currency INTO operating_currency FROM business_settings WHERE singleton;
        IF operating_currency IS NULL THEN
            RAISE EXCEPTION 'Set the operating currency before creating invoices';
        END IF;
        IF NEW.currency IS NOT NULL AND NEW.currency <> operating_currency THEN
            RAISE EXCEPTION 'Invoice currency must match the operating currency';
        END IF;
        NEW.currency := operating_currency;
        RETURN NEW;
    END IF;

    IF OLD.issued_at IS NOT NULL THEN
        IF (to_jsonb(NEW) - 'revision') IS DISTINCT FROM (to_jsonb(OLD) - 'revision') THEN
            RAISE EXCEPTION 'Issued invoices are immutable';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.kind, NEW.job_id, NEW.currency) IS DISTINCT FROM (OLD.kind, OLD.job_id, OLD.currency) THEN
        RAISE EXCEPTION 'Invoice type, job and currency are fixed at creation';
    END IF;
    IF NEW.issued_by IS NULL THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = OLD.id) THEN
        RAISE EXCEPTION 'An invoice requires at least one line';
    END IF;

    IF NEW.kind = 'service' THEN
        SELECT * INTO invoice_job FROM jobs WHERE id = NEW.job_id;
        IF NOT FOUND OR invoice_job.status <> 'completed' OR
           invoice_job.customer_id IS DISTINCT FROM NEW.customer_id THEN
            RAISE EXCEPTION 'A service invoice requires the completed job and its customer';
        END IF;
        IF EXISTS (
            SELECT 1 FROM invoice_lines l
            LEFT JOIN job_labor w ON w.id = l.labor_id
            LEFT JOIN part_requests r ON r.id = l.part_request_id
            WHERE l.invoice_id = OLD.id AND NOT (
                (w.id IS NOT NULL AND w.job_id = NEW.job_id AND w.amount = l.base_unit_price)
                OR (r.id IS NOT NULL AND r.job_id = NEW.job_id AND r.status = 'fulfilled'
                    AND r.part_id = l.part_id AND r.quantity = l.quantity
                    AND r.fulfilled_unit_price = l.base_unit_price)
            )
        ) OR EXISTS (
            SELECT 1 FROM job_labor w WHERE w.job_id = NEW.job_id
            AND NOT EXISTS (
                SELECT 1 FROM invoice_lines l WHERE l.invoice_id = OLD.id AND l.labor_id = w.id
            )
        ) OR EXISTS (
            SELECT 1 FROM part_requests r WHERE r.job_id = NEW.job_id AND r.status = 'fulfilled'
            AND NOT EXISTS (
                SELECT 1 FROM invoice_lines l WHERE l.invoice_id = OLD.id AND l.part_request_id = r.id
            )
        ) THEN
            RAISE EXCEPTION 'Invoice lines must match all labor and fulfilled parts for this job';
        END IF;
    END IF;

    IF NEW.customer_id IS NOT NULL THEN
        SELECT coalesce(NEW.bill_to_name, full_name),
               coalesce(NEW.bill_to_contact, email, phone)
        INTO NEW.bill_to_name, NEW.bill_to_contact
        FROM customers WHERE id = NEW.customer_id;
    ELSE
        NEW.bill_to_name := coalesce(NEW.bill_to_name, 'Walk-in customer');
    END IF;
    NEW.issued_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_guard BEFORE INSERT OR UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION guard_invoice();

CREATE FUNCTION deduct_shop_sale_parts() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    INSERT INTO stock_movements (part_id, quantity_delta, invoice_line_id, reason, recorded_by)
    SELECT part_id, -quantity, id, 'Walk-in sale', NEW.issued_by
    FROM invoice_lines WHERE invoice_id = NEW.id ORDER BY part_id, id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_deduct_shop_sale AFTER UPDATE ON invoices
FOR EACH ROW WHEN (NEW.kind = 'shop_sale' AND OLD.issued_at IS NULL AND NEW.issued_at IS NOT NULL)
EXECUTE FUNCTION deduct_shop_sale_parts();

CREATE FUNCTION guard_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status <> 'pending' THEN
            RAISE EXCEPTION 'Reviewed payments are immutable';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['status', 'reviewed_by', 'reviewed_at'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'reviewed_by', 'reviewed_at']) THEN
            RAISE EXCEPTION 'Payment details are fixed at creation';
        END IF;
    END IF;
    UPDATE invoices SET revision = revision + 1 WHERE id = NEW.invoice_id AND issued_at IS NOT NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payments require an issued invoice';
    END IF;

    IF NEW.status <> 'pending' THEN
        NEW.reviewed_at := clock_timestamp();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard BEFORE INSERT OR UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION guard_payment();

CREATE FUNCTION check_payment_balance() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
DECLARE
    invoice_total numeric;
    confirmed_total numeric;
BEGIN
    SELECT coalesce(sum(line_total), 0) INTO invoice_total
    FROM invoice_lines WHERE invoice_id = NEW.invoice_id;
    SELECT coalesce(sum(amount), 0) INTO confirmed_total
    FROM payments WHERE invoice_id = NEW.invoice_id AND status = 'confirmed';
    IF confirmed_total > invoice_total THEN
        RAISE EXCEPTION 'Payment would exceed the invoice balance';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER payments_balance AFTER INSERT OR UPDATE OF status ON payments
FOR EACH ROW WHEN (NEW.status = 'confirmed') EXECUTE FUNCTION check_payment_balance();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION reject_change();

CREATE FUNCTION guard_feedback() RETURNS trigger
LANGUAGE plpgsql SET search_path = garage, pg_catalog AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM jobs WHERE id = NEW.job_id AND status = 'completed') THEN
        RAISE EXCEPTION 'Feedback requires a completed job';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER feedback_guard BEFORE INSERT OR UPDATE OF job_id ON feedback
FOR EACH ROW EXECUTE FUNCTION guard_feedback();

CREATE VIEW low_stock_alerts AS
SELECT id AS part_id, sku, name, supplier_id, stock_quantity, reorder_threshold,
       (stock_quantity = 0) AS out_of_stock
FROM parts
WHERE is_active AND stock_quantity <= reorder_threshold;

CREATE VIEW invoice_balances AS
SELECT i.id AS invoice_id, 'INV-' || i.id AS invoice_number, i.kind, i.job_id,
       i.customer_id, i.bill_to_name, i.bill_to_contact, i.currency, i.issued_at,
       l.total, p.paid_amount, l.total - p.paid_amount AS balance_due,
       CASE WHEN p.paid_amount = l.total THEN 'paid'
            WHEN p.paid_amount = 0 THEN 'unpaid'
            ELSE 'partial' END AS payment_status
FROM invoices i
CROSS JOIN LATERAL (
    SELECT coalesce(sum(line_total), 0) AS total FROM invoice_lines WHERE invoice_id = i.id
) l
CROSS JOIN LATERAL (
    SELECT coalesce(sum(amount), 0) AS paid_amount
    FROM payments WHERE invoice_id = i.id AND status = 'confirmed'
) p
WHERE i.issued_at IS NOT NULL;

CREATE VIEW receipts AS
SELECT p.id AS payment_id, 'RCT-' || p.id AS receipt_number, i.invoice_id,
       i.invoice_number, i.bill_to_name, i.bill_to_contact, i.currency,
       p.amount, p.method, p.external_reference, p.reviewed_at AS confirmed_at
FROM payments p JOIN invoice_balances i ON i.invoice_id = p.invoice_id
WHERE p.status = 'confirmed';

-- Revenue is cash received in the configured reporting time zone.
CREATE VIEW monthly_revenue AS
SELECT date_trunc('month', p.reviewed_at AT TIME ZONE s.reporting_timezone)::date AS month,
       i.currency, sum(p.amount) AS revenue
FROM payments p JOIN invoices i ON i.id = p.invoice_id
CROSS JOIN business_settings s
WHERE p.status = 'confirmed'
GROUP BY 1, 2;

CREATE VIEW top_selling_parts AS
SELECT p.id AS part_id, p.sku, p.name, i.currency,
       sum(l.quantity) AS units_sold, sum(l.line_total) AS invoiced_sales
FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
JOIN parts p ON p.id = l.part_id
WHERE i.issued_at IS NOT NULL
GROUP BY p.id, i.currency;

CREATE VIEW mechanic_performance AS
SELECT u.id AS mechanic_id, u.full_name, count(j.id) AS completed_jobs
FROM users u LEFT JOIN jobs j ON j.mechanic_id = u.id AND j.status = 'completed'
WHERE u.role_code = 'mechanic' OR j.id IS NOT NULL
GROUP BY u.id;

COMMIT;
