package org.agentcity.paper;

public final class StrictJsonCheck {
    public static void main(String[] args) {
        if(!StrictJson.object("{\"n\":1,\"a\":[true,null,\"x\"]}").get("n").equals(1L)) throw new AssertionError("integer representation");
        String[] invalid={"{} {}","[]","{\"x\":1,\"x\":2}","{\"x\":{\"y\":1,\"y\":2}}","{\"n\":1.0}","{\"n\":1e3}","{\"n\":9223372036854775808}","{\"n\":NaN}","{\"x\":1,}","{x:1}","//comment\n{}","{\"n\":01}","[".repeat(14)+"0"+"]".repeat(14)," ".repeat(65537)};
        for(String text:invalid) {
            boolean refused=false;
            try { StrictJson.object(text); } catch (IllegalArgumentException|IllegalStateException expected) {refused=true;}
            if(!refused) throw new AssertionError("accepted malformed input: "+text);
        }
        System.out.println("StrictJsonCheck PASS: 1 valid and "+invalid.length+" refused payloads");
    }
}
