import {NextRequest,NextResponse} from 'next/server';
import {requireApiAuth} from '@/lib/api-auth';
import {getSupabaseAdmin} from '@/lib/supabase-admin';
import {capacityConfirmationSchema} from '@/lib/dialer/budget';

export async function POST(request:NextRequest){
 const auth=await requireApiAuth(request,{mutation:true});if(auth)return auth;
 const parsed=capacityConfirmationSchema.safeParse(await request.json());
 if(!parsed.success)return NextResponse.json({error:'Enter the actual account ceiling, available channels and a dated portal/support reference.'},{status:400});
 const now=Date.now();const confirmation={...parsed.data,verification:'manual',confirmedAt:new Date(now).toISOString(),expiresAt:new Date(now+4*3600000).toISOString()};
 const r=await getSupabaseAdmin().from('app_settings').upsert({key:'dialer_account_capacity',value_json:confirmation},{onConflict:'key'});
 if(r.error)return NextResponse.json({error:r.error.message},{status:503});
 return NextResponse.json({confirmation});
}
