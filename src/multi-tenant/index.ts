/**
 * Bu modul MUSTAQIL — server.ts'ga hali ulanmagan (hozirgi production
 * single-tenant sxema bilan to'qnashmasligi uchun ataylab). Haqiqiy loyihaga
 * ko'chirishda quyidagicha ulanadi:
 *
 *   import authRoutes from './multi-tenant/routes/auth';
 *   import campaignRoutes from './multi-tenant/routes/campaigns';
 *   import callRoutes from './multi-tenant/routes/calls';
 *   import userRoutes from './multi-tenant/routes/users';
 *   import integrationRoutes from './multi-tenant/routes/integrations';
 *   import companyRoutes from './multi-tenant/routes/company';
 *
 *   app.set('trust proxy', 1);                            // X-Forwarded-For'ga ishonish uchun (rate limit)
 *   app.use('/auth', authRoutes);                          // ochiq — withAuth talab qilmaydi
 *   app.use('/campaigns', campaignRoutes);                 // ichida withAuth + requireRole
 *   app.use('/calls', callRoutes);                         // ichida withAuth
 *   app.use('/users', userRoutes);                         // ichida withAuth + requireRole
 *   app.use('/company', companyRoutes);                    // ichida withAuth + requireRole
 *   app.use('/company/integrations', integrationRoutes);   // ichida withAuth + requireRole
 *
 * To'liq oqim uchun IKKALA SQL faylni tartib bilan ishga tushiring:
 *   1. supabase/multi_tenant_saas.sql                    (companies/users/campaigns/calls/api_keys + RLS + Vault)
 *   2. supabase/multi_tenant_saas_rate_limit_audit.sql    (rate-limit jadvallari + audit_logs)
 */
export { withAuth, invalidateProfileCache, type AuthedRequest, type AuthContext } from './middleware/withAuth';
export { requireRole } from './middleware/requireRole';
export { supabaseAdmin } from './lib/supabaseAdmin';
