-- Respaldo completo de fraud_db (fraud-service): esquema + datos de ejemplo (database/seed.sql).
-- Generado con pg_dump --no-owner --no-privileges. Restaurar en una base vacía:
--   psql "$DATABASE_URL" -f database/backup.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id character varying NOT NULL,
    staff_username character varying NOT NULL,
    action character varying NOT NULL,
    target_type character varying NOT NULL,
    target_id character varying NOT NULL,
    reason character varying(300),
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    staff_role character varying
);


--
-- Name: flagged_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flagged_transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    id_user character varying NOT NULL,
    score integer NOT NULL,
    reason character varying(500) NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    reviewed_by character varying,
    resolution_note character varying(300),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone
);


--
-- Name: fraud_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fraud_outbox (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    routing_key character varying NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fraud_transaction_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fraud_transaction_log (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    id_user character varying NOT NULL,
    type character varying NOT NULL,
    direction character varying NOT NULL,
    amount numeric(18,2) NOT NULL,
    currency character varying(3) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: risk_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.risk_scores (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    score integer NOT NULL,
    model_version character varying DEFAULT 'rules-v1'::character varying NOT NULL,
    rules_triggered jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Data for Name: admin_audit; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.admin_audit (id, staff_id, staff_username, action, target_type, target_id, reason, details, created_at, staff_role) FROM stdin;
\.


--
-- Data for Name: flagged_transactions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.flagged_transactions (id, transaction_id, account_id, id_user, score, reason, status, reviewed_by, resolution_note, created_at, reviewed_at) FROM stdin;
43000000-0000-4000-8000-0000000000e1	7b000000-0000-4000-8000-000000000001	3a000000-0000-4000-8000-000000000001	11111111-1111-4111-8111-111111111111	40	Monto alto para una cuenta nueva	pending	\N	\N	2026-10-01 15:00:00+00	\N
\.


--
-- Data for Name: fraud_outbox; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fraud_outbox (id, routing_key, payload, occurred_at, published_at, attempts, last_error, created_at) FROM stdin;
\.


--
-- Data for Name: fraud_transaction_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fraud_transaction_log (id, transaction_id, account_id, id_user, type, direction, amount, currency, occurred_at, created_at) FROM stdin;
43000000-0000-4000-8000-000000000012	7b000000-0000-4000-8000-000000000001	3a000000-0000-4000-8000-000000000001	11111111-1111-4111-8111-111111111111	deposit	in	1000000.00	COP	2026-10-01 15:00:00+00	2026-10-18 06:13:25.698037+00
43000000-0000-4000-8000-000000000021	7b000000-0000-4000-8000-000000000002	3a000000-0000-4000-8000-000000000001	11111111-1111-4111-8111-111111111111	transfer	out	150000.00	COP	2026-10-02 15:00:00+00	2026-10-18 06:13:25.698037+00
43000000-0000-4000-8000-000000000022	7b000000-0000-4000-8000-000000000002	3a000000-0000-4000-8000-000000000002	22222222-2222-4222-8222-222222222222	transfer	in	150000.00	COP	2026-10-02 15:00:00+00	2026-10-18 06:13:25.698037+00
43000000-0000-4000-8000-000000000031	7b000000-0000-4000-8000-000000000003	3a000000-0000-4000-8000-000000000001	11111111-1111-4111-8111-111111111111	saving	out	200000.00	COP	2026-10-03 15:00:00+00	2026-10-18 06:13:25.698037+00
43000000-0000-4000-8000-000000000041	7b000000-0000-4000-8000-000000000004	3a000000-0000-4000-8000-000000000001	11111111-1111-4111-8111-111111111111	payment	out	85000.00	COP	2026-10-04 15:00:00+00	2026-10-18 06:13:25.698037+00
\.


--
-- Data for Name: risk_scores; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.risk_scores (id, transaction_id, account_id, score, model_version, rules_triggered, created_at) FROM stdin;
43000000-0000-4000-8000-0000000000f1	7b000000-0000-4000-8000-000000000001	3a000000-0000-4000-8000-000000000001	40	rules-v1	[{"rule": "monto_alto", "detail": "Consignación de $1.000.000", "points": 40}]	2026-10-01 15:00:00+00
\.


--
-- Name: fraud_transaction_log PK_47540c326157825e543674c14c3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fraud_transaction_log
    ADD CONSTRAINT "PK_47540c326157825e543674c14c3" PRIMARY KEY (id);


--
-- Name: admin_audit PK_5ad48a4d9d16397ef37e28bb0be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT "PK_5ad48a4d9d16397ef37e28bb0be" PRIMARY KEY (id);


--
-- Name: fraud_outbox PK_858f2c185b87d47394171c5a082; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fraud_outbox
    ADD CONSTRAINT "PK_858f2c185b87d47394171c5a082" PRIMARY KEY (id);


--
-- Name: risk_scores PK_ac76f1fbfc456572b6ed51abe8f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.risk_scores
    ADD CONSTRAINT "PK_ac76f1fbfc456572b6ed51abe8f" PRIMARY KEY (id);


--
-- Name: flagged_transactions PK_c4682a847e361fb5210a563b147; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flagged_transactions
    ADD CONSTRAINT "PK_c4682a847e361fb5210a563b147" PRIMARY KEY (id);


--
-- Name: IDX_8decd83b4b9593f5219e5f3085; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8decd83b4b9593f5219e5f3085" ON public.admin_audit USING btree (target_id);


--
-- Name: IDX_aabe6acd3d6eaa021bdc8d2a41; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_aabe6acd3d6eaa021bdc8d2a41" ON public.flagged_transactions USING btree (account_id);


--
-- Name: idx_admin_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_created ON public.admin_audit USING btree (created_at);


--
-- Name: idx_flagged_tx_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flagged_tx_status_time ON public.flagged_transactions USING btree (status, created_at);


--
-- Name: idx_fraud_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_outbox_pending ON public.fraud_outbox USING btree (published_at, created_at);


--
-- Name: idx_fraud_tx_log_account_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fraud_tx_log_account_time ON public.fraud_transaction_log USING btree (account_id, occurred_at);


--
-- Name: idx_fraud_tx_log_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fraud_tx_log_unique ON public.fraud_transaction_log USING btree (transaction_id, account_id);


--
-- Name: idx_risk_scores_account_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_risk_scores_account_time ON public.risk_scores USING btree (account_id, created_at);


--
-- PostgreSQL database dump complete
--


