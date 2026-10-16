public class Conditionals {
    public static void main(String[] args) {

        // Problem 1: The Movie Age Check
        // Variable to store the person's age
        int age = 15;
        System.out.println("Movie Age Check (age = " + age + "):");
        // Check if the person is 13 or older
        if (age >= 13) {
            System.out.println("Welcome to the movie!");
        } else {
            System.out.println("You are not old enough.");
        }

        System.out.println();

        // Problem 2: The Weekend Check
        // Variable to store the day of the week
        String day = "Saturday";
        System.out.println("Weekend Check (day = " + day + "):");
        // Check if the day is Saturday or Sunday
        if (day.equals("Saturday") || day.equals("Sunday")) {
            System.out.println("It's the weekend! ");
        } else {
            System.out.println(" Back to work/school.");
        }

        System.out.println();

        // Problem 3: Temperature Recommendation
        // Variable to store the temperature
        int temp = 40;
        System.out.println("Temperature Recommendation (temp = " + temp + "):");
        // Check if temperature is less than 32
        if (temp < 32) {
            System.out.println("Stay inside!");
        } else {
            System.out.println("Perfect weather!");
        }

        System.out.println();

        // Problem 4: The Passing Grade
        // Variable to store the test score
        int score = 85;
        System.out.println("Passing Grade (score = " + score + "):");
        // Check if score is 70 or higher
        if (score >= 70) {
            System.out.println("You Passed!");
        } else {
            System.out.println("Needs Improvement.");
        }

        System.out.println();

        // Problem 5: Positive or Negative
        // Variable to store the number
        int number = -7;
        System.out.println("Positive or Negative (number = " + number + "):");
        // Check if number is positive, otherwise negative
        if (number > 0) {
            System.out.println("Positive");
        } else if (number < 0) {
            System.out.println("Negative");
        }
    }
}
