package org.agentcity.paper;

import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import com.google.gson.Strictness;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Preserve integer types and reject duplicate keys before command validation. */
final class StrictJson {
    static Map<String,Object> object(String text) {
        if (text == null || text.length() > 65536) throw new IllegalArgumentException("payload_size");
        try (JsonReader reader = new JsonReader(new StringReader(text))) {
            reader.setStrictness(Strictness.STRICT);
            Object value = read(reader,0);
            if (!(value instanceof Map<?,?>) || reader.peek()!=JsonToken.END_DOCUMENT) throw new IllegalArgumentException("object_required");
            @SuppressWarnings("unchecked") Map<String,Object> result=(Map<String,Object>) value;
            return result;
        } catch (java.io.IOException e) { throw new IllegalArgumentException("malformed_json",e); }
    }
    private static Object read(JsonReader r,int depth) throws java.io.IOException {
        if(depth>12) throw new IllegalArgumentException("payload_depth");
        return switch (r.peek()) {
            case BEGIN_OBJECT -> {
                r.beginObject(); Map<String,Object> out=new LinkedHashMap<>();
                while(r.hasNext()) {
                    if(out.size()>=256) throw new IllegalArgumentException("object_size");
                    String key=r.nextName();
                    if(out.containsKey(key)) throw new IllegalArgumentException("duplicate_key");
                    out.put(key,read(r,depth+1));
                }
                r.endObject(); yield out;
            }
            case BEGIN_ARRAY -> {
                r.beginArray(); List<Object> out=new ArrayList<>();
                while(r.hasNext()) {
                    if(out.size()>=4096) throw new IllegalArgumentException("array_size");
                    out.add(read(r,depth+1));
                }
                r.endArray(); yield out;
            }
            case STRING -> r.nextString();
            case BOOLEAN -> r.nextBoolean();
            case NULL -> { r.nextNull(); yield null; }
            case NUMBER -> {
                String n=r.nextString();
                if(!n.matches("-?(0|[1-9][0-9]*)")) throw new IllegalArgumentException("integer_required");
                try { yield Long.parseLong(n); } catch (NumberFormatException e) { throw new IllegalArgumentException("integer_overflow"); }
            }
            default -> throw new IllegalArgumentException("malformed_json");
        };
    }
}
