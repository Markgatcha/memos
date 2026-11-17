public class NestedLoops {

    public static void main(String[] args) {

        // 1) 3x3 square of asterisks using nested for loops
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 3; col++) {
                System.out.print("*");
            }
            System.out.println();
        }

        System.out.println(); // blank line between the two outputs

        // 2) Number grid: 3 rows, each showing numbers 1 through 4, using nested while loops
        int r = 0;
        while (r < 3) {
            int num = 1;
            while (num <= 4) {
                System.out.print(num + " ");
                num++;
            }
            System.out.println();
            r++;
        }
    }
}
