
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://djbhipofzbonxfqriovi.supabase.co";
const SUPABASE_ANON_KEY = "sb-publishable-DX7aNwHHI7tb6RUiWWe0qg_qPzuLcld";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
