/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
const fs = require('fs');
const path = require('path');

const dirs = [
  'app/(protected)/automations',
  'app/api/automations/lead-demo-prep/summary',
  'app/api/automations/lead-demo-prep/batches',
  'app/api/automations/lead-demo-prep/batches/[id]/cancel',
  'app/api/automations/lead-demo-prep/jobs/[id]/retry',
  'app/api/automations/lead-demo-prep/prepared-leads',
  'app/api/automations/lead-demo-prep/leads/[leadId]/prepare',
  'components/layout',
  'lib/demo-agent'
];

dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));

fs.writeFileSync('lib/demo-agent/automation.ts', `
import { SupabaseClient } from '@supabase/supabase-js';

export async function getLeadDemoPreparationStatus(supabase: SupabaseClient, organizationId: string, leadId: string) {
  return { status: 'not_prepared', canActivate: false, canPrepare: true, isDemoReady: false, blockers: [] };
}

export async function prepareLeadDemoProfile({ supabase, organizationId, leadId, forceReprocess, batchId, jobId }: any) {
  return { skipped: false, profileId: 'mock-id' };
}
`);

fs.writeFileSync('app/(protected)/automations/page.tsx', `
import React from 'react';

export default function AutomationsPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-2">Automations</h1>
      <p className="text-gray-500 mb-6">Pre prepare clinic demo agents before outreach so activation is instant during calls.</p>
      
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="p-4 border rounded shadow-sm">Total Leads</div>
        <div className="p-4 border rounded shadow-sm">Demo Prepared</div>
        <div className="p-4 border rounded shadow-sm">Ready to Activate</div>
        <div className="p-4 border rounded shadow-sm">Needs Scraping</div>
      </div>

      <div className="border rounded p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4">Batch Preparation</h2>
        <button className="bg-blue-600 text-white px-4 py-2 rounded">Prepare Demo Profiles</button>
      </div>

      <div className="border rounded p-6">
        <h2 className="text-lg font-semibold mb-4">Current / Recent Batches</h2>
        <table className="w-full text-left">
          <thead>
            <tr>
              <th>Batch ID</th>
              <th>Status</th>
              <th>Requested</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={4} className="text-center py-4">No batches found</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
`);

fs.writeFileSync('app/api/automations/lead-demo-prep/summary/route.ts', `
import { NextResponse } from 'next/server';
export async function GET() { return NextResponse.json({ total_leads: 0, prepared_count: 0 }); }
`);

fs.writeFileSync('app/api/automations/lead-demo-prep/batches/route.ts', `
import { NextResponse } from 'next/server';
export async function GET() { return NextResponse.json([]); }
export async function POST() { return NextResponse.json({ success: true }); }
`);

fs.writeFileSync('app/api/automations/lead-demo-prep/batches/[id]/route.ts', `
import { NextResponse } from 'next/server';
export async function GET() { return NextResponse.json({}); }
`);

fs.writeFileSync('app/api/automations/lead-demo-prep/batches/[id]/cancel/route.ts', `
import { NextResponse } from 'next/server';
export async function POST() { return NextResponse.json({ success: true }); }
`);

fs.writeFileSync('app/api/automations/lead-demo-prep/jobs/[id]/retry/route.ts', `
import { NextResponse } from 'next/server';
export async function POST() { return NextResponse.json({ success: true }); }
`);

fs.writeFileSync('app/api/automations/lead-demo-prep/prepared-leads/route.ts', `
import { NextResponse } from 'next/server';
export async function GET() { return NextResponse.json([]); }
`);

fs.writeFileSync('app/api/automations/lead-demo-prep/leads/[leadId]/prepare/route.ts', `
import { NextResponse } from 'next/server';
export async function POST() { return NextResponse.json({ success: true }); }
`);

// Updating Layout sidebar mock
fs.writeFileSync('components/layout/mobile-nav.tsx', `
import Link from 'next/link';
export function MobileNav() {
  return (
    <nav>
      <Link href="/dashboard">Dashboard</Link>
      <Link href="/leads">Leads</Link>
      <Link href="/workspace">Calling Workspace</Link>
      <Link href="/automations">Automations</Link>
    </nav>
  );
}
`);

console.log('Generated base framework');
