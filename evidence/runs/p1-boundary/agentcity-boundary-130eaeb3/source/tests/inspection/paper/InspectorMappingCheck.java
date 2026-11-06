package org.agentcity.paper;

import java.time.Clock;
import java.util.*;

public final class InspectorMappingCheck {
    private static int checks;
    private static CalculatorInspector.Port p(String name,int x,int y,int z,int weight,String group){return new CalculatorInspector.Port(name,x,y,z,weight,group);}
    private static List<CalculatorInspector.Port> inputs(int x,int y,int z){return List.of(p("a0",x,y+4,z,1,"a"),p("a1",x+4,y+3,z+1,2,"a"),p("b0",x,y+3,z+1,1,"b"),p("b1",x+4,y+1,z+1,2,"b"));}
    private static List<CalculatorInspector.Port> outputs(int x,int y,int z){return List.of(p("s0",x+4,y+7,z-1,1,"output"),p("s1",x+13,y+9,z+2,2,"output"),p("c1",x+11,y+6,z-1,4,"output"));}
    private static void accept(List<CalculatorInspector.Port> in,List<CalculatorInspector.Port> out){new CalculatorInspector(null,null,null,in,out,()->0,Clock.systemUTC());checks++;}
    private static void reject(List<CalculatorInspector.Port> in,List<CalculatorInspector.Port> out){try{accept(in,out);}catch(IllegalArgumentException expected){checks++;return;}throw new AssertionError("accepted mismatched control mapping");}
    public static void main(String[] args){
        for(int origin:new int[]{-100,-1,0,100})accept(inputs(origin,80,origin),outputs(origin,80,origin));
        List<CalculatorInspector.Port> in=inputs(0,0,0),out=outputs(0,0,0);
        for(boolean isInput:new boolean[]{true,false}) {
            List<CalculatorInspector.Port> original=isInput?in:out;
            for(int slot=0;slot<original.size();slot++) {
                var old=original.get(slot);
                List<CalculatorInspector.Port> invalid=List.of(p("wrong",old.x(),old.y(),old.z(),old.weight(),old.group()),p(old.name(),old.x()+1,old.y(),old.z(),old.weight(),old.group()),p(old.name(),old.x(),old.y()+1,old.z(),old.weight(),old.group()),p(old.name(),old.x(),old.y(),old.z()+1,old.weight(),old.group()),p(old.name(),old.x(),old.y(),old.z(),old.weight()+1,old.group()),p(old.name(),old.x(),old.y(),old.z(),old.weight(),"wrong"));
                for(var changed:invalid){var values=new ArrayList<>(original);values.set(slot,changed);reject(isInput?values:in,isInput?out:values);}
            }
            var missing=new ArrayList<>(original);missing.removeLast();reject(isInput?missing:in,isInput?out:missing);
            var duplicate=new ArrayList<>(original);duplicate.set(0,original.get(1));reject(isInput?duplicate:in,isInput?out:duplicate);
        }
        var swapped=new ArrayList<>(in);var a=in.get(0);var b=in.get(2);swapped.set(0,p(a.name(),b.x(),b.y(),b.z(),a.weight(),a.group()));swapped.set(2,p(b.name(),a.x(),a.y(),a.z(),b.weight(),b.group()));reject(swapped,out);
        System.out.println("InspectorMappingCheck PASS: "+checks+" assertions");
    }
}
