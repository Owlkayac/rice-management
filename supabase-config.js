// Supabase の接続先です。スマホなどから使うため、このファイルは GitHub に上げています。
// Publishable key は公開される前提のキーです。データは、ログインと RLS（使う人のリスト）で守っています。
//
// ここに入れてよいのは Publishable key（sb_publishable_ で始まるキー）だけです。
// ブラウザで動くファイルなので、それ以外のキー（secret key・service_role key）は絶対に書かないでください。
const SUPABASE_URL = "https://aacfbxcbuesrfolmxltc.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_7xwemnemDoXZ7tGKIxbhCA_pxO1AWeC";
